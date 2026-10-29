import http from "node:http";
import { isDirectRun, listen, PayloadTooLargeError, readBody, sendJson } from "../shared/http.js";
import { logError } from "../shared/logger.js";
import { gatewayError } from "./errors.js";
import { openUsageDatabase, TokenRateLimiter } from "./rate-limiter.js";
import { routeCompletion } from "./router.js";

export type ModelGatewayOptions = {
  limiter: TokenRateLimiter;
  primaryUrl: string;
  secondaryUrl: string;
  primaryModel?: string;
  secondaryModel?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

function apiKeyFrom(req: http.IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header === "string") {
    const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
    if (match?.[1]) return match[1];
  }
  const apiKey = req.headers["x-api-key"];
  if (typeof apiKey === "string" && apiKey.trim().length > 0) return apiKey.trim();
  return null;
}

export function createModelGateway(options: ModelGatewayOptions): http.Server {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { ok: true, service: "model-router" });
      return;
    }
    if (req.method !== "POST" || url.pathname !== "/v1/chat/completions") {
      const requestId = crypto.randomUUID();
      const error = gatewayError("invalid_request", requestId);
      sendJson(res, 404, error.body, { "x-request-id": requestId });
      return;
    }

    const requestId = crypto.randomUUID();
    const apiKey = apiKeyFrom(req);
    if (!apiKey) {
      const error = gatewayError("unauthorized", requestId);
      sendJson(res, error.status, error.body, { "x-request-id": requestId, "www-authenticate": "Bearer" });
      return;
    }

    let raw: string;
    try {
      raw = await readBody(req);
    } catch (error) {
      const status = error instanceof PayloadTooLargeError ? 413 : 400;
      const body = gatewayError("invalid_request", requestId);
      sendJson(res, status, body.body, { "x-request-id": requestId });
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const body = gatewayError("invalid_request", requestId);
      sendJson(res, body.status, body.body, { "x-request-id": requestId });
      return;
    }

    const parent = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) parent.abort();
    });

    try {
      const routed = await routeCompletion({
        rawBody: raw,
        parsedBody: parsed,
        apiKey,
        limiter: options.limiter,
        primary: { url: options.primaryUrl, ...(options.primaryModel ? { model: options.primaryModel } : {}) },
        secondary: { url: options.secondaryUrl, ...(options.secondaryModel ? { model: options.secondaryModel } : {}) },
        ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        requestId,
        signal: parent.signal,
      });
      sendJson(res, routed.status, routed.body, routed.headers);
    } catch {
      logError("model-router", "request failed", { requestId });
      const body = gatewayError("upstream_unavailable", requestId);
      if (!res.writableEnded) sendJson(res, body.status, body.body, { "x-request-id": requestId });
    }
  });
}

if (isDirectRun(import.meta.url)) {
  const primaryUrl = process.env.PRIMARY_URL;
  const secondaryUrl = process.env.SECONDARY_URL;
  if (!primaryUrl || !secondaryUrl) {
    logError("model-router", "PRIMARY_URL and SECONDARY_URL are required");
    process.exit(1);
  }
  const port = Number(process.env.PORT ?? 43143);
  const host = process.env.HOST ?? "127.0.0.1";
  const db = openUsageDatabase(process.env.SQLITE_PATH ?? "data/usage.sqlite");
  const limiter = new TokenRateLimiter(db);
  const server = createModelGateway({
    limiter,
    primaryUrl,
    secondaryUrl,
    ...(process.env.PRIMARY_MODEL ? { primaryModel: process.env.PRIMARY_MODEL } : {}),
    ...(process.env.SECONDARY_MODEL ? { secondaryModel: process.env.SECONDARY_MODEL } : {}),
  });
  listen(server, port, host)
    .then(() => {
      logError("model-router", "listening", { host, port });
    })
    .catch(() => {
      logError("model-router", "failed to listen");
      process.exit(1);
    });
}
