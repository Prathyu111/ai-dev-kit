import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { TOKEN_LIMIT_PER_MINUTE, WINDOW_MS } from "./errors.js";

export type Reservation =
  | {
      ok: true;
      eventId: number;
      used: number;
      remaining: number;
      limit: number;
    }
  | {
      ok: false;
      reason: "rate_limit_exceeded" | "request_exceeds_limit";
      used: number;
      limit: number;
      retryAfterMs: number;
    };

type CountRow = { total: number | bigint | null };
type EventRow = { tokens: number; recorded_at_ms: number };

export function hashApiKey(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex");
}

export function openUsageDatabase(filename: string): DatabaseSync {
  if (filename !== ":memory:") {
    mkdirSync(dirname(filename), { recursive: true });
  }
  const db = new DatabaseSync(filename);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 3000;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS token_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key_hash TEXT NOT NULL,
      tokens INTEGER NOT NULL CHECK (tokens > 0),
      recorded_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_token_events_key_time
      ON token_events (key_hash, recorded_at_ms);
  `);
  return db;
}

/**
 * Token-aware sliding window. Check and insert run inside one IMMEDIATE
 * transaction so two gateway processes cannot both admit the same last token.
 * Rows older than the window are deleted on every reservation.
 */
export class TokenRateLimiter {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(
    private readonly db: DatabaseSync,
    options: { limit?: number; windowMs?: number; now?: () => number } = {},
  ) {
    this.limit = options.limit ?? TOKEN_LIMIT_PER_MINUTE;
    this.windowMs = options.windowMs ?? WINDOW_MS;
    this.now = options.now ?? Date.now;
  }

  reserve(apiKey: string, tokens: number): Reservation {
    if (!Number.isInteger(tokens) || tokens <= 0) {
      throw new Error("tokens must be a positive integer");
    }
    const keyHash = hashApiKey(apiKey);
    const now = this.now();
    const cutoff = now - this.windowMs;

    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM token_events WHERE recorded_at_ms <= ?").run(cutoff);
      const used = this.sumSince(keyHash, cutoff);
      if (tokens > this.limit || used + tokens > this.limit) {
        const reason = tokens > this.limit ? "request_exceeds_limit" : "rate_limit_exceeded";
        const retryAfterMs = reason === "request_exceeds_limit" ? 0 : this.retryAfter(keyHash, used + tokens - this.limit, now);
        this.db.exec("COMMIT");
        return { ok: false, reason, used, limit: this.limit, retryAfterMs };
      }
      const info = this.db
        .prepare("INSERT INTO token_events (key_hash, tokens, recorded_at_ms) VALUES (?, ?, ?)")
        .run(keyHash, tokens, now);
      this.db.exec("COMMIT");
      const eventId = Number(info.lastInsertRowid);
      return {
        ok: true,
        eventId,
        used: used + tokens,
        remaining: this.limit - (used + tokens),
        limit: this.limit,
      };
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // The original failure is the one worth surfacing.
      }
      throw error;
    }
  }

  release(eventId: number): void {
    this.db.prepare("DELETE FROM token_events WHERE id = ?").run(eventId);
  }

  adjust(eventId: number, tokens: number): void {
    if (!Number.isInteger(tokens) || tokens <= 0) return;
    this.db.prepare("UPDATE token_events SET tokens = ? WHERE id = ?").run(tokens, eventId);
  }

  usage(apiKey: string): number {
    const now = this.now();
    const cutoff = now - this.windowMs;
    this.db.prepare("DELETE FROM token_events WHERE recorded_at_ms <= ?").run(cutoff);
    return this.sumSince(hashApiKey(apiKey), cutoff);
  }

  storedEventCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS total FROM token_events").get() as CountRow;
    return Number(row.total ?? 0);
  }

  private sumSince(keyHash: string, cutoff: number): number {
    const row = this.db
      .prepare(
        "SELECT COALESCE(SUM(tokens), 0) AS total FROM token_events WHERE key_hash = ? AND recorded_at_ms > ?",
      )
      .get(keyHash, cutoff) as CountRow;
    return Number(row.total ?? 0);
  }

  private retryAfter(keyHash: string, overflow: number, now: number): number {
    const rows = this.db
      .prepare(
        `SELECT tokens, recorded_at_ms FROM token_events
         WHERE key_hash = ? AND recorded_at_ms > ?
         ORDER BY recorded_at_ms ASC`,
      )
      .all(keyHash, now - this.windowMs) as unknown as EventRow[];
    let freed = 0;
    let when = now + this.windowMs;
    for (const row of rows) {
      freed += Number(row.tokens);
      when = Number(row.recorded_at_ms) + this.windowMs;
      if (freed >= overflow) break;
    }
    return Math.max(0, when - now);
  }
}
