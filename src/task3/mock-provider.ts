import http from "node:http";
import { isDirectRun, listen, readBody, sendJson } from "../shared/http.js";
import { logError } from "../shared/logger.js";

export const CANNED_COMPLETION =
  "Hello from Quilr. Contact billing@example.com about SSN 123-45-6789 and card 4111 1111 1111 1111 before noon.";

const CHUNK_SIZE = 5;

function event(delta: Record<string, unknown>, finishReason: string | null): string {
  return `data: ${JSON.stringify({
    id: "chatcmpl-mock",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

export function createMockLlmServer(): http.Server {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { ok: true, service: "mock-llm" });
      return;
    }
    if (req.method !== "POST" || url.pathname !== "/v1/chat/completions") {
      sendJson(res, 404, { error: { message: "Not found" } });
      return;
    }

    let stream = true;
    try {
      const parsed = JSON.parse(await readBody(req)) as { stream?: unknown };
      stream = parsed.stream !== false;
    } catch {
      sendJson(res, 400, { error: { message: "Invalid JSON" } });
      return;
    }

    if (!stream) {
      sendJson(res, 200, {
        id: "chatcmpl-mock",
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: CANNED_COMPLETION }, finish_reason: "stop" }],
      });
      return;
    }

    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
    });
    res.write(event({ role: "assistant" }, null));
    for (let index = 0; index < CANNED_COMPLETION.length; index += CHUNK_SIZE) {
      res.write(event({ content: CANNED_COMPLETION.slice(index, index + CHUNK_SIZE) }, null));
    }
    res.write(event({}, "stop"));
    res.write("data: [DONE]\n\n");
    res.end();
  });
}

if (isDirectRun(import.meta.url)) {
  const port = Number(process.env.PORT ?? 43131);
  const host = process.env.HOST ?? "127.0.0.1";
  const server = createMockLlmServer();
  listen(server, port, host)
    .then(() => {
      logError("mock-llm", "listening", { host, port });
    })
    .catch(() => {
      logError("mock-llm", "failed to listen");
      process.exit(1);
    });
}
