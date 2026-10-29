import http from "node:http";
import { isDirectRun, listen, sendJson } from "../shared/http.js";
import { logError } from "../shared/logger.js";

export type MockMode = "ok" | "429" | "500" | "hang";

export function createMockUpstream(options: { mode?: MockMode; delayMs?: number } = {}): http.Server {
  const defaultMode = options.mode ?? "ok";
  const delayMs = options.delayMs ?? 0;

  return http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { ok: true, mode: defaultMode });
      return;
    }
    if (req.method !== "POST") {
      sendJson(res, 404, { error: { message: "Not found" } });
      return;
    }

    const chunks: Buffer[] = [];
    req.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on("error", () => {
      if (!res.writableEnded) res.end();
    });
    req.on("end", () => {
      const headerMode = req.headers["x-mock-mode"];
      const mode = (typeof headerMode === "string" ? headerMode : defaultMode) as MockMode;
      if (mode === "hang") return;

      const send = () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let model = "mock-model";
        try {
          const parsed = JSON.parse(raw) as { model?: unknown };
          if (typeof parsed.model === "string") model = parsed.model;
        } catch {
          model = "mock-model";
        }
        if (mode === "429") {
          sendJson(res, 429, {
            error: "Error: rate limit\n    at Object.handler (/secret/upstream.js:10:1)",
          });
          return;
        }
        if (mode === "500") {
          sendJson(res, 500, {
            error: "Error: boom\n    at hidden (/var/secret/stack.js:1:1)",
          });
          return;
        }
        sendJson(res, 200, {
          id: "cmpl-mock",
          object: "chat.completion",
          model,
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        });
      };

      if (delayMs > 0) setTimeout(send, delayMs);
      else send();
    });
  });
}

if (isDirectRun(import.meta.url)) {
  const port = Number(process.env.PORT ?? 43141);
  const host = process.env.HOST ?? "127.0.0.1";
  const mode = (process.env.MODE ?? "ok") as MockMode;
  const server = createMockUpstream({ mode });
  listen(server, port, host)
    .then(() => {
      logError("mock-upstream", "listening", { host, port, mode });
    })
    .catch(() => {
      logError("mock-upstream", "failed to listen");
      process.exit(1);
    });
}
