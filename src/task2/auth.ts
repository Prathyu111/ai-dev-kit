import { INVALID_PARAMS, UNAUTHORIZED_TOOL_CALL } from "./jsonrpc.js";

export type Role = "admin" | "viewer";

/** Local demo credentials. Override or extend with MCP_GATEWAY_TOKENS=token:role,... */
export const DEMO_TOKENS: Readonly<Record<string, Role>> = {
  quilr_admin_demo: "admin",
  quilr_viewer_demo: "viewer",
};

export function loadTokenMap(env: NodeJS.ProcessEnv = process.env): Map<string, Role> {
  const tokens = new Map<string, Role>();
  if (env.MCP_GATEWAY_DEMO_TOKENS !== "0") {
    for (const [token, role] of Object.entries(DEMO_TOKENS)) {
      tokens.set(token, role);
    }
  }
  const extra = env.MCP_GATEWAY_TOKENS;
  if (!extra) return tokens;
  for (const part of extra.split(",")) {
    const separator = part.indexOf(":");
    if (separator <= 0) continue;
    const token = part.slice(0, separator).trim();
    const role = part.slice(separator + 1).trim();
    if (!token) continue;
    if (role === "admin" || role === "viewer") tokens.set(token, role);
  }
  return tokens;
}

export function extractRole(
  authorization: string | undefined,
  tokens: ReadonlyMap<string, Role>,
): { role: Role; token: string } | null {
  if (!authorization) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(authorization.trim());
  if (!match) return null;
  const token = match[1];
  if (!token) return null;
  const role = tokens.get(token);
  if (!role) return null;
  return { role, token };
}

export type AuthorizationDecision =
  | { action: "forward" }
  | { action: "reject"; status: number; code: number; message: string };

/**
 * tools/list is forwarded for every authenticated role.
 * tools/call is forwarded unless the tool name starts with "admin_" and the role is not admin.
 * Any other method is forwarded once the caller has a valid token.
 */
export function authorize(role: Role, method: string, params: unknown): AuthorizationDecision {
  if (method !== "tools/call") return { action: "forward" };

  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return { action: "reject", status: 200, code: INVALID_PARAMS, message: "Invalid params" };
  }
  const name = (params as { name?: unknown }).name;
  if (typeof name !== "string" || name.length === 0) {
    return { action: "reject", status: 200, code: INVALID_PARAMS, message: "Invalid params" };
  }
  if (name.startsWith("admin_") && role !== "admin") {
    return {
      action: "reject",
      status: 200,
      code: UNAUTHORIZED_TOOL_CALL,
      message: "Unauthorized Tool Call",
    };
  }
  return { action: "forward" };
}
