import http from "node:http";
import { logError } from "../shared/logger.js";
import { isDirectRun, listen, readBody, sendJson, PayloadTooLargeError } from "../shared/http.js";
import { authorize, extractRole, loadTokenMap, type Role } from "./auth.js";
import { INTERNAL_ERROR, parseRpc, rpcError, UNAUTHORIZED_TOOL_CALL } from "./jsonrpc.js";

export type GatewayOptions = {
  downstreamUrl: string;
  tokens?: ReadonlyMap<string, Role>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

function fingerprint(token: string): string {
  return `…${token.slice(-4)}`;
}

export function createGateway(options: GatewayOptions): http.Server {
  const tokens = options.tokens ?? loadTokenMap();
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;

  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { ok: true, service: "mcp-gateway" });
      return;
    }
    if (req.method !== "POST" || url.pathname !== "/mcp") {
      sendJson(res, 404, rpcError(null, -32601, "Method not found"));
      return;
    }

    let raw: string;
    try {
      raw = await readBody(req);
    } catch (error) {
      if (error instanceof PayloadTooLargeError) {
        sendJson(res, 413, rpcError(null, -32600, "Invalid Request"));
        return;
      }
      sendJson(res, 400, rpcError(null, -32700, "Parse error"));
      return;
    }

    const parsed = parseRpc(raw);
    if (!parsed.ok) {
      sendJson(res, parsed.status, rpcError(parsed.id, parsed.code, parsed.message));
      return;
    }

    const header = typeof req.headers.authorization === "string" ? req.headers.authorization : undefined;
    const identity = extractRole(header, tokens);
    if (!identity) {
      logError("mcp-gateway", "rejected unauthenticated request", { method: parsed.method });
      sendJson(res, 401, rpcError(parsed.id, UNAUTHORIZED_TOOL_CALL, "Unauthorized"), {
        "www-authenticate": "Bearer",
      });
      return;
    }

    const decision = authorize(identity.role, parsed.method, parsed.params);
    if (decision.action === "reject") {
      logError("mcp-gateway", "rejected tool call", {
        method: parsed.method,
        role: identity.role,
        token: fingerprint(identity.token),
        code: decision.code,
      });
      sendJson(res, decision.status, rpcError(parsed.id, decision.code, decision.message));
      return;
    }

    try {
      const downstream = await fetchImpl(options.downstreamUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        body: parsed.raw,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const body = Buffer.from(await downstream.arrayBuffer());
      const contentType = downstream.headers.get("content-type") ?? "application/json; charset=utf-8";
      logError("mcp-gateway", "forwarded", {
        method: parsed.method,
        role: identity.role,
        status: downstream.status,
      });
      res.writeHead(downstream.status, {
        "content-type": contentType,
        "content-length": body.length,
      });
      res.end(body);
    } catch {
      logError("mcp-gateway", "downstream unavailable", { method: parsed.method });
      sendJson(res, 502, rpcError(parsed.id, INTERNAL_ERROR, "Downstream MCP server unavailable"));
    }
  });
}

if (isDirectRun(import.meta.url)) {
  const port = Number(process.env.PORT ?? 43122);
  const host = process.env.HOST ?? "127.0.0.1";
  const downstreamUrl = process.env.DOWNSTREAM_URL ?? "http://127.0.0.1:43121/mcp";
  const server = createGateway({ downstreamUrl });
  listen(server, port, host)
    .then(() => {
      logError("mcp-gateway", "listening", { host, port, downstreamUrl });
    })
    .catch(() => {
      logError("mcp-gateway", "failed to listen");
      process.exit(1);
    });
}
