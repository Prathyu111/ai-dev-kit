import http from "node:http";
import { isDirectRun, listen, readBody, sendJson } from "../shared/http.js";
import { logError } from "../shared/logger.js";
import { INVALID_PARAMS, parseRpc, type JsonRpcId } from "./jsonrpc.js";

const METHOD_NOT_FOUND_CODE = -32601;

export type RecordedCall = {
  method: string;
  tool?: string;
  raw: string;
};

const TOOLS = [
  {
    name: "get_customer_record",
    description: "Read a customer record.",
    inputSchema: {
      type: "object" as const,
      properties: { customer_id: { type: "string" } },
      required: ["customer_id"],
    },
  },
  {
    name: "lookup_order",
    description: "Look up an order by id.",
    inputSchema: {
      type: "object" as const,
      properties: { order_id: { type: "string" } },
      required: ["order_id"],
    },
  },
  {
    name: "admin_reset_key",
    description: "Rotate an administrative API key.",
    inputSchema: {
      type: "object" as const,
      properties: { key_id: { type: "string" } },
      required: ["key_id"],
    },
  },
];

function result(id: JsonRpcId, value: unknown) {
  return { jsonrpc: "2.0" as const, id, result: value };
}

function failure(id: JsonRpcId, code: number, message: string) {
  return { jsonrpc: "2.0" as const, id, error: { code, message } };
}

function toolText(value: unknown) {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
  };
}

export function createDownstreamServer(): { server: http.Server; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { ok: true, service: "mock-mcp" });
      return;
    }
    if (req.method === "GET" && url.pathname === "/_meta/calls") {
      sendJson(res, 200, { calls });
      return;
    }
    if (req.method !== "POST" || url.pathname !== "/mcp") {
      sendJson(res, 404, failure(null, METHOD_NOT_FOUND_CODE, "Method not found"));
      return;
    }

    const raw = await readBody(req);
    const parsed = parseRpc(raw);
    if (!parsed.ok) {
      sendJson(res, parsed.status, failure(parsed.id, parsed.code, parsed.message));
      return;
    }

    const tool = toolName(parsed.params);
    calls.push({ method: parsed.method, ...(tool ? { tool } : {}), raw });

    if (parsed.method === "initialize") {
      sendJson(res, 200, result(parsed.id, {
        protocolVersion: "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "mock-downstream", version: "1.0.0" },
      }));
      return;
    }
    if (parsed.method === "ping" || parsed.method === "notifications/initialized") {
      sendJson(res, 200, result(parsed.id, {}));
      return;
    }
    if (parsed.method === "tools/list") {
      sendJson(res, 200, result(parsed.id, { tools: TOOLS }));
      return;
    }
    if (parsed.method === "tools/call") {
      if (!tool) {
        sendJson(res, 200, failure(parsed.id, INVALID_PARAMS, "Invalid params"));
        return;
      }
      if (tool === "admin_reset_key") {
        sendJson(res, 200, result(parsed.id, toolText({ reset: true, key_id: argument(parsed.params, "key_id") ?? "key" })));
        return;
      }
      if (tool === "lookup_order") {
        sendJson(res, 200, result(parsed.id, toolText({ order_id: argument(parsed.params, "order_id"), status: "shipped" })));
        return;
      }
      if (tool === "get_customer_record") {
        sendJson(res, 200, result(parsed.id, toolText({ customer_id: argument(parsed.params, "customer_id"), name: "Avery Chen" })));
        return;
      }
      sendJson(res, 200, failure(parsed.id, INVALID_PARAMS, `Unknown tool: ${tool}`));
      return;
    }

    sendJson(res, 200, failure(parsed.id, METHOD_NOT_FOUND_CODE, "Method not found"));
  });

  return { server, calls };
}

function toolName(params: unknown): string | undefined {
  if (!params || typeof params !== "object" || Array.isArray(params)) return undefined;
  const name = (params as { name?: unknown }).name;
  return typeof name === "string" ? name : undefined;
}

function argument(params: unknown, key: string): string | undefined {
  if (!params || typeof params !== "object" || Array.isArray(params)) return undefined;
  const args = (params as { arguments?: unknown }).arguments;
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
  const value = (args as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

if (isDirectRun(import.meta.url)) {
  const port = Number(process.env.PORT ?? 43121);
  const host = process.env.HOST ?? "127.0.0.1";
  const { server } = createDownstreamServer();
  listen(server, port, host)
    .then(() => {
      logError("mock-mcp", "listening", { host, port });
    })
    .catch(() => {
      logError("mock-mcp", "failed to listen");
      process.exit(1);
    });
}
