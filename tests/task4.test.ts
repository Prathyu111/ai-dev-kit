import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { estimateRequestTokens } from "../src/task4/estimate.js";
import { TOKEN_LIMIT_PER_MINUTE, UPSTREAM_TIMEOUT_MS, WINDOW_MS } from "../src/task4/errors.js";
import { createModelGateway } from "../src/task4/gateway.js";
import { createMockUpstream } from "../src/task4/mock-upstream.js";
import { hashApiKey, openUsageDatabase, TokenRateLimiter } from "../src/task4/rate-limiter.js";
import { routeCompletion } from "../src/task4/router.js";
import { close, listen, postJson } from "./helpers.js";

const directories: string[] = [];
const servers: Array<import("node:http").Server> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => close(server)));
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function database() {
  const directory = mkdtempSync(join(tmpdir(), "quilr-usage-"));
  directories.push(directory);
  const filename = join(directory, "usage.sqlite");
  return { filename, db: openUsageDatabase(filename) };
}

const prompt = { messages: [{ role: "user", content: "hello" }], max_tokens: 20 };

describe("task 4 token window", () => {
  it("uses the documented budget and estimates prompt plus reserved completion tokens", () => {
    expect(TOKEN_LIMIT_PER_MINUTE).toBe(50_000);
    expect(WINDOW_MS).toBe(60_000);
    expect(UPSTREAM_TIMEOUT_MS).toBe(3_000);
    expect(estimateRequestTokens({ messages: [{ role: "user", content: "a".repeat(400) }], max_tokens: 50 })).toEqual({
      ok: true,
      tokens: 150,
    });
    expect(estimateRequestTokens({ messages: [] })).toEqual({ ok: false });
    expect(estimateRequestTokens({ messages: [{ role: "user", content: "hi" }], max_tokens: 1.5 })).toEqual({ ok: false });
  });

  it("enforces a sliding window, evicts expired rows, and keeps keys isolated", () => {
    const { db } = database();
    let now = 1_000_000;
    const limiter = new TokenRateLimiter(db, { limit: 50_000, now: () => now });
    expect(limiter.reserve("tenant-a", 40_000).ok).toBe(true);
    expect(limiter.storedEventCount()).toBe(1);
    now += 30_000;
    const denied = limiter.reserve("tenant-a", 20_000);
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.reason).toBe("rate_limit_exceeded");
      expect(denied.retryAfterMs).toBe(30_000);
    }
    expect(limiter.reserve("tenant-b", 20_000).ok).toBe(true);
    now += 30_001;
    expect(limiter.reserve("tenant-a", 20_000).ok).toBe(true);
    expect(limiter.storedEventCount()).toBe(2);
    const tooBig = limiter.reserve("tenant-a", 50_001);
    expect(tooBig.ok).toBe(false);
    if (!tooBig.ok) expect(tooBig.reason).toBe("request_exceeds_limit");
  });

  it("serializes admissions and persists the window on disk without storing the raw key", () => {
    const { filename, db } = database();
    const limiter = new TokenRateLimiter(db, { limit: 1_000, now: () => 5_000 });
    const results = Array.from({ length: 10 }, () => limiter.reserve("shared", 300));
    expect(results.filter((result) => result.ok)).toHaveLength(3);
    expect(limiter.usage("shared")).toBe(900);

    const persisted = openUsageDatabase(filename);
    const second = new TokenRateLimiter(persisted, { limit: 1_000, now: () => 5_000 });
    expect(second.reserve("shared", 300).ok).toBe(false);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    const bytes = readFileSync(filename);
    expect(bytes.includes(Buffer.from("shared"))).toBe(false);
    expect(bytes.includes(Buffer.from(hashApiKey("shared")))).toBe(true);
    db.close();
  });

  it("replaces the estimate with reported usage and releases the reservation on failure", () => {
    const { db } = database();
    const limiter = new TokenRateLimiter(db, { limit: 100, now: () => 10 });
    const reserved = limiter.reserve("tenant", 80);
    expect(reserved.ok).toBe(true);
    if (reserved.ok) limiter.adjust(reserved.eventId, 9);
    expect(limiter.usage("tenant")).toBe(9);
    const failed = limiter.reserve("other", 40);
    expect(failed.ok).toBe(true);
    if (failed.ok) limiter.release(failed.eventId);
    expect(limiter.usage("other")).toBe(0);
  });
});

describe("task 4 model router", () => {
  it("fails over on 429 and on timeout, and does not fail over on a primary 500", async () => {
    const primaryHang = createMockUpstream({ mode: "hang" });
    const primaryLimited = createMockUpstream({ mode: "429" });
    const primaryBroken = createMockUpstream({ mode: "500" });
    const secondary = createMockUpstream({ mode: "ok" });
    servers.push(primaryHang, primaryLimited, primaryBroken, secondary);
    const [hangPort, limitedPort, brokenPort, secondaryPort] = await Promise.all([
      listen(primaryHang),
      listen(primaryLimited),
      listen(primaryBroken),
      listen(secondary),
    ]);
    const secondaryTarget = {
      url: `http://127.0.0.1:${secondaryPort}/v1/chat/completions`,
      model: "quilr-backup",
    };
    const { db } = database();
    const limiter = new TokenRateLimiter(db, { limit: 50_000, now: () => 20_000 });
    const rawBody = JSON.stringify({ ...prompt, model: "quilr-primary" });

    const limited = await routeCompletion({
      rawBody,
      parsedBody: JSON.parse(rawBody),
      apiKey: "tenant-key",
      limiter,
      primary: { url: `http://127.0.0.1:${limitedPort}/v1/chat/completions` },
      secondary: secondaryTarget,
      timeoutMs: 500,
    });
    expect(limited.route).toBe("secondary");
    expect(limited.status).toBe(200);
    expect(limited.body).toMatchObject({ model: "quilr-backup" });
    expect(JSON.stringify(limited.body)).not.toContain("secret");

    const started = Date.now();
    const timedOut = await routeCompletion({
      rawBody,
      parsedBody: JSON.parse(rawBody),
      apiKey: "tenant-key",
      limiter,
      primary: { url: `http://127.0.0.1:${hangPort}/v1/chat/completions` },
      secondary: secondaryTarget,
      timeoutMs: 300,
    });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(timedOut.route).toBe("secondary");

    const broken = await routeCompletion({
      rawBody,
      parsedBody: JSON.parse(rawBody),
      apiKey: "tenant-key",
      limiter,
      primary: { url: `http://127.0.0.1:${brokenPort}/v1/chat/completions` },
      secondary: { url: "http://127.0.0.1:1/does-not-exist" },
      timeoutMs: 500,
    });
    expect(broken.route).toBe("none");
    expect(broken.status).toBe(502);
    expect(JSON.stringify(broken.body)).not.toContain("boom");
    expect(JSON.stringify(broken.body)).not.toContain("/var/secret");
    expect(broken.body).toMatchObject({
      error: { type: "gateway_error", code: "upstream_unavailable" },
    });
  });

  it("returns a sanitized rate-limit payload and refunds tokens when every provider fails", async () => {
    const { db } = database();
    let now = 50_000;
    const limiter = new TokenRateLimiter(db, { limit: 100, now: () => now });
    const broken = createMockUpstream({ mode: "500" });
    const healthy = createMockUpstream({ mode: "ok" });
    servers.push(broken, healthy);
    const [brokenPort, healthyPort] = await Promise.all([listen(broken), listen(healthy)]);
    const body = { messages: [{ role: "user", content: "a".repeat(40) }], max_tokens: 60 };
    const rawBody = JSON.stringify(body);
    const failed = await routeCompletion({
      rawBody,
      parsedBody: body,
      apiKey: "refund-me",
      limiter,
      primary: { url: `http://127.0.0.1:${brokenPort}/v1/chat/completions` },
      secondary: { url: "http://127.0.0.1:1/unused" },
      timeoutMs: 300,
    });
    expect(failed.status).toBe(502);
    expect(limiter.usage("refund-me")).toBe(0);

    const gateway = createModelGateway({
      limiter,
      primaryUrl: `http://127.0.0.1:${healthyPort}/v1/chat/completions`,
      secondaryUrl: "http://127.0.0.1:1/unused",
      timeoutMs: 300,
    });
    const gatewayPort = await listen(gateway);
    servers.push(gateway);
    const admitted = await postJson(
      `http://127.0.0.1:${gatewayPort}/v1/chat/completions`,
      { messages: [{ role: "user", content: "hi" }], max_tokens: 90 },
      { authorization: "Bearer refund-me" },
    );
    expect(admitted.status).toBe(200);
    expect(admitted.headers.get("x-model-route")).toBe("primary");
    const blocked = await postJson(
      `http://127.0.0.1:${gatewayPort}/v1/chat/completions`,
      { messages: [{ role: "user", content: "hi" }], max_tokens: 90 },
      { authorization: "Bearer refund-me" },
    );
    expect(blocked.status).toBe(429);
    expect(blocked.json).toMatchObject({
      error: { type: "gateway_error", code: "rate_limit_exceeded" },
    });
    expect(blocked.text).not.toContain("stack");
    expect(blocked.headers.get("x-ratelimit-limit")).toBe("100");

    const missing = await postJson(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, body);
    expect(missing.status).toBe(401);
    expect(missing.text).not.toContain("Error:");
  });

  it("returns a sanitized timeout when both providers hang", async () => {
    const primary = createMockUpstream({ mode: "hang" });
    const secondary = createMockUpstream({ mode: "hang" });
    servers.push(primary, secondary);
    const [primaryPort, secondaryPort] = await Promise.all([listen(primary), listen(secondary)]);
    const { db } = database();
    const limiter = new TokenRateLimiter(db, { limit: 50_000, now: () => 1 });
    const rawBody = JSON.stringify(prompt);
    const result = await routeCompletion({
      rawBody,
      parsedBody: prompt,
      apiKey: "tenant-key",
      limiter,
      primary: { url: `http://127.0.0.1:${primaryPort}/v1/chat/completions` },
      secondary: { url: `http://127.0.0.1:${secondaryPort}/v1/chat/completions` },
      timeoutMs: 200,
    });
    expect(result.status).toBe(504);
    expect(result.body).toMatchObject({ error: { type: "gateway_error", code: "upstream_timeout" } });
    expect(JSON.stringify(result.body)).not.toContain("AbortError");
    expect(limiter.usage("tenant-key")).toBe(0);
  });
});
