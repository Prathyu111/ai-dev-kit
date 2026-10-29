import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { getCustomer, triggerRefund } from "./customers.js";
import { parseToolArguments, TOOL_DEFINITIONS } from "./schemas.js";
import { logError } from "../shared/logger.js";

export const SERVER_INFO = {
  name: "quilr-customer-ops",
  version: "1.0.0",
} as const;

type TextResult = {
  content: [{ type: "text"; text: string }];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

function rpcFailure(code: number, message: string, data?: unknown): Error {
  const error = new Error(message) as Error & { code: number; data?: unknown };
  error.code = code;
  if (data !== undefined) error.data = data;
  return error;
}

function textResult(value: Record<string, unknown>, isError = false): TextResult {
  const result: TextResult = {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
  };
  if (isError) result.isError = true;
  return result;
}

/**
 * Low-level SDK server. The high-level McpServer helper catches validation
 * failures and turns them into a successful JSON-RPC result with isError: true.
 * Invalid input is thrown with code -32602 so it stays on the JSON-RPC error
 * channel. The Error message is left unprefixed; McpError would write
 * "MCP error -32602:" into the wire message and clients wrap that again.
 */
export function createCustomerServer(): Server {
  const server = new Server(SERVER_INFO, {
    capabilities: { tools: {} },
    instructions:
      "Customer operations. customer_id must match CUST-XXXXX (five digits). Refund amount must be a positive number and reason must be at least 10 characters.",
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = request.params.arguments ?? {};
    try {
      const parsed = parseToolArguments(name, args);
      if (!parsed.ok) {
        throw rpcFailure(ErrorCode.InvalidParams, parsed.message, { issues: parsed.issues });
      }

      if (parsed.name === "get_customer_record") {
        logError("customer-ops", "tools/call", { tool: parsed.name, customer_id: parsed.data.customer_id });
        const customer = getCustomer(parsed.data.customer_id);
        if (!customer) {
          return textResult({ error: `No customer found for ${parsed.data.customer_id}` }, true);
        }
        return textResult({ ...customer });
      }

      logError("customer-ops", "tools/call", {
        tool: parsed.name,
        customer_id: parsed.data.customer_id,
        amount: parsed.data.amount,
      });
      const refund = triggerRefund(parsed.data);
      if (!refund.ok) {
        return textResult({ error: refund.error }, true);
      }
      return textResult({ ...refund.refund });
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error) throw error;
      logError("customer-ops", "tool execution failed", { tool: name });
      throw rpcFailure(ErrorCode.InternalError, "Tool execution failed");
    }
  });

  return server;
}
