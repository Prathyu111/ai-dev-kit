export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;
/** Assessment-defined application error for a denied admin tool call. */
export const UNAUTHORIZED_TOOL_CALL = -32001;

export type JsonRpcId = string | number | null;

export type RpcErrorBody = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: {
    code: number;
    message: string;
  };
};

export type RpcSuccess = {
  ok: true;
  id: JsonRpcId;
  method: string;
  params: unknown;
  raw: string;
};

export type RpcFailure = {
  ok: false;
  status: number;
  id: JsonRpcId;
  code: number;
  message: string;
};

export function rpcError(id: JsonRpcId, code: number, message: string): RpcErrorBody {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message },
  };
}

export function parseRpc(raw: string): RpcSuccess | RpcFailure {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, status: 400, id: null, code: PARSE_ERROR, message: "Parse error" };
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, status: 400, id: null, code: INVALID_REQUEST, message: "Invalid Request" };
  }

  const record = value as Record<string, unknown>;
  const id = record.id;
  if (id !== undefined && id !== null && typeof id !== "string" && typeof id !== "number") {
    return { ok: false, status: 400, id: null, code: INVALID_REQUEST, message: "Invalid Request" };
  }
  const safeId: JsonRpcId = id === undefined ? null : id;

  if (record.jsonrpc !== "2.0" || typeof record.method !== "string" || record.method.length === 0) {
    return { ok: false, status: 400, id: safeId, code: INVALID_REQUEST, message: "Invalid Request" };
  }
  if (id === undefined) {
    return { ok: false, status: 400, id: null, code: INVALID_REQUEST, message: "Invalid Request" };
  }

  return {
    ok: true,
    id: id,
    method: record.method,
    params: record.params,
    raw,
  };
}
