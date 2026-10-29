export const TOKEN_LIMIT_PER_MINUTE = 50_000;
export const WINDOW_MS = 60_000;
export const UPSTREAM_TIMEOUT_MS = 3_000;

export type GatewayErrorCode =
  | "rate_limit_exceeded"
  | "request_exceeds_limit"
  | "unauthorized"
  | "invalid_request"
  | "upstream_timeout"
  | "upstream_rate_limited"
  | "upstream_unavailable";

const STATUS: Record<GatewayErrorCode, number> = {
  rate_limit_exceeded: 429,
  request_exceeds_limit: 400,
  unauthorized: 401,
  invalid_request: 400,
  upstream_timeout: 504,
  upstream_rate_limited: 429,
  upstream_unavailable: 502,
};

const MESSAGES: Record<GatewayErrorCode, string> = {
  rate_limit_exceeded: "Token budget exceeded for this API key. Try again when the sliding window frees capacity.",
  request_exceeds_limit: "This request exceeds the per-minute token budget on its own.",
  unauthorized: "A tenant API key is required.",
  invalid_request: "The completion request is missing a prompt or has an invalid token estimate.",
  upstream_timeout: "The model provider did not respond before the gateway timeout.",
  upstream_rate_limited: "Model providers are rate limiting requests. Try again shortly.",
  upstream_unavailable: "The model provider could not complete the request.",
};

export type GatewayErrorBody = {
  error: {
    type: "gateway_error";
    code: GatewayErrorCode;
    message: string;
    request_id: string;
    retry_after_ms?: number;
  };
};

export function gatewayError(
  code: GatewayErrorCode,
  requestId: string,
  extra?: { retryAfterMs?: number },
): { status: number; body: GatewayErrorBody } {
  const error: GatewayErrorBody["error"] = {
    type: "gateway_error",
    code,
    message: MESSAGES[code],
    request_id: requestId,
  };
  if (extra?.retryAfterMs !== undefined) error.retry_after_ms = extra.retryAfterMs;
  return { status: STATUS[code], body: { error } };
}
