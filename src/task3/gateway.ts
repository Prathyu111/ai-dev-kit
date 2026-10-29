import http from "node:http";
import { isDirectRun, listen, PayloadTooLargeError, readBody, sendJson } from "../shared/http.js";
import { logError } from "../shared/logger.js";
import { OpenAiSseRedactor, redactCompletionPayload } from "./sse.js";

export type GuardrailOptions = {
  upstreamUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

type GatewayErrorBody = {
  error: {
    type: "gateway_error";
    code: "invalid_request" | "upstream_unavailable";
    message: string;
    request_id: string;
  };
};

function errorBody(code: GatewayErrorBody["error"]["code"], requestId: string): GatewayErrorBody {
  const message =
    code === "invalid_request"
      ? "The generation request body is not valid JSON."
      : "The model provider could not complete the request.";
  return { error: { type: "gateway_error", code, message, request_id: requestId } };
}

function wantsStream(body: unknown): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  return (body as { stream?: unknown }).stream === true;
}

export function createGuardrailServer(options: GuardrailOptions): http.Server {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 60_000;

  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { ok: true, service: "llm-guardrail" });
      return;
    }
    if (req.method !== "POST" || url.pathname !== "/v1/chat/completions") {
      sendJson(res, 404, errorBody("invalid_request", crypto.randomUUID()));
      return;
    }

    const requestId = crypto.randomUUID();
    let raw: string;
    try {
      raw = await readBody(req);
    } catch (error) {
      const status = error instanceof PayloadTooLargeError ? 413 : 400;
      sendJson(res, status, errorBody("invalid_request", requestId));
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      sendJson(res, 400, errorBody("invalid_request", requestId));
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      sendJson(res, 400, errorBody("invalid_request", requestId));
      return;
    }

    const stream = wantsStream(parsed);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: stream ? "text/event-stream, application/json" : "application/json",
    };
    if (typeof req.headers.authorization === "string") {
      headers.authorization = req.headers.authorization;
    }

    let upstream: Response;
    try {
      upstream = await fetchImpl(options.upstreamUrl, {
        method: "POST",
        headers,
        body: raw,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      logError("llm-guardrail", "upstream unreachable", { requestId });
      sendJson(res, 502, errorBody("upstream_unavailable", requestId));
      return;
    }

    if (!upstream.ok) {
      await upstream.body?.cancel().catch(() => undefined);
      logError("llm-guardrail", "upstream error status", { requestId, status: upstream.status });
      sendJson(res, 502, errorBody("upstream_unavailable", requestId));
      return;
    }

    if (!stream) {
      try {
        const text = await upstream.text();
        const payload = JSON.parse(text) as unknown;
        sendJson(res, 200, redactCompletionPayload(payload), { "x-request-id": requestId });
      } catch {
        logError("llm-guardrail", "upstream payload unreadable", { requestId });
        sendJson(res, 502, errorBody("upstream_unavailable", requestId));
      }
      return;
    }

    const reader = upstream.body?.getReader();
    if (!reader) {
      sendJson(res, 502, errorBody("upstream_unavailable", requestId));
      return;
    }

    const redactor = new OpenAiSseRedactor();
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      "x-request-id": requestId,
    });

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const next = redactor.push(value);
        if (next.length > 0) res.write(next);
      }
      const tail = redactor.finish();
      if (tail.length > 0) res.write(tail);
      res.end();
    } catch {
      logError("llm-guardrail", "stream interrupted", { requestId });
      await reader.cancel().catch(() => undefined);
      if (!res.writableEnded) res.end();
    }
  });
}

if (isDirectRun(import.meta.url)) {
  const port = Number(process.env.PORT ?? 43132);
  const host = process.env.HOST ?? "127.0.0.1";
  const upstreamUrl = process.env.UPSTREAM_URL ?? "http://127.0.0.1:43131/v1/chat/completions";
  const server = createGuardrailServer({ upstreamUrl });
  listen(server, port, host)
    .then(() => {
      logError("llm-guardrail", "listening", { host, port, upstreamUrl });
    })
    .catch(() => {
      logError("llm-guardrail", "failed to listen");
      process.exit(1);
    });
}
