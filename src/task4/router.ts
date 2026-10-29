import { estimateRequestTokens, readReportedUsage } from "./estimate.js";
import { gatewayError, UPSTREAM_TIMEOUT_MS } from "./errors.js";
import type { TokenRateLimiter } from "./rate-limiter.js";

export type ProviderTarget = {
  url: string;
  model?: string;
};

export type RouteResult = {
  status: number;
  body: unknown;
  headers: Record<string, string>;
  route: "primary" | "secondary" | "none";
};

type UpstreamResult =
  | { kind: "response"; status: number; text: string }
  | { kind: "network"; timedOut: boolean };

async function readLimited(response: Response, limit: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > limit) {
      await reader.cancel();
      throw new Error("upstream body too large");
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return text;
}

async function postUpstream(
  target: ProviderTarget,
  rawBody: string,
  timeoutMs: number,
  fetchImpl: typeof fetch,
  parent?: AbortSignal,
): Promise<UpstreamResult> {
  if (parent?.aborted) return { kind: "network", timedOut: false };
  const controller = new AbortController();
  const onParent = () => controller.abort();
  parent?.addEventListener("abort", onParent, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(target.url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: bodyFor(rawBody, target.model),
      signal: controller.signal,
    });
    if (response.status < 200 || response.status >= 300) {
      await response.body?.cancel().catch(() => undefined);
      return { kind: "response", status: response.status, text: "" };
    }
    const text = await readLimited(response, 1_000_000);
    return { kind: "response", status: response.status, text };
  } catch {
    return { kind: "network", timedOut: controller.signal.aborted && !parent?.aborted };
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener("abort", onParent);
  }
}

function bodyFor(rawBody: string, model: string | undefined): string {
  if (!model) return rawBody;
  const parsed = JSON.parse(rawBody) as Record<string, unknown>;
  parsed.model = model;
  return JSON.stringify(parsed);
}

function shouldFailover(result: UpstreamResult): boolean {
  return (result.kind === "response" && result.status === 429) || (result.kind === "network" && result.timedOut);
}

function parseSuccess(text: string): unknown | undefined {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export async function routeCompletion(input: {
  rawBody: string;
  parsedBody: unknown;
  apiKey: string;
  limiter: TokenRateLimiter;
  primary: ProviderTarget;
  secondary: ProviderTarget;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  requestId?: string;
  signal?: AbortSignal;
}): Promise<RouteResult> {
  const requestId = input.requestId ?? crypto.randomUUID();
  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? UPSTREAM_TIMEOUT_MS;
  const baseHeaders = { "x-request-id": requestId };

  const estimate = estimateRequestTokens(input.parsedBody);
  if (!estimate.ok) {
    const error = gatewayError("invalid_request", requestId);
    return { status: error.status, body: error.body, headers: baseHeaders, route: "none" };
  }

  const reservation = input.limiter.reserve(input.apiKey, estimate.tokens);
  if (!reservation.ok) {
    const code = reservation.reason === "request_exceeds_limit" ? "request_exceeds_limit" : "rate_limit_exceeded";
    const error = gatewayError(code, requestId, {
      retryAfterMs: reservation.reason === "rate_limit_exceeded" ? reservation.retryAfterMs : undefined,
    });
    return {
      status: error.status,
      body: error.body,
      headers: {
        ...baseHeaders,
        "x-ratelimit-limit": String(reservation.limit),
        "x-ratelimit-remaining": "0",
      },
      route: "none",
    };
  }

  const finishSuccess = (route: "primary" | "secondary", text: string): RouteResult => {
    const body = parseSuccess(text);
    if (body === undefined) {
      input.limiter.release(reservation.eventId);
      const error = gatewayError("upstream_unavailable", requestId);
      return { status: error.status, body: error.body, headers: baseHeaders, route: "none" };
    }
    const reported = readReportedUsage(body);
    if (reported !== null) input.limiter.adjust(reservation.eventId, reported);
    const used = input.limiter.usage(input.apiKey);
    return {
      status: 200,
      body,
      headers: {
        ...baseHeaders,
        "x-model-route": route,
        "x-ratelimit-limit": String(reservation.limit),
        "x-ratelimit-remaining": String(Math.max(0, reservation.limit - used)),
      },
      route,
    };
  };

  const fail = (code: Parameters<typeof gatewayError>[0]): RouteResult => {
    input.limiter.release(reservation.eventId);
    const error = gatewayError(code, requestId);
    return { status: error.status, body: error.body, headers: baseHeaders, route: "none" };
  };

  try {
    const primary = await postUpstream(input.primary, input.rawBody, timeoutMs, fetchImpl, input.signal);
    if (primary.kind === "response" && primary.status >= 200 && primary.status < 300) {
      return finishSuccess("primary", primary.text);
    }
    if (!shouldFailover(primary)) {
      return fail("upstream_unavailable");
    }

    const secondary = await postUpstream(input.secondary, input.rawBody, timeoutMs, fetchImpl, input.signal);
    if (secondary.kind === "response" && secondary.status >= 200 && secondary.status < 300) {
      return finishSuccess("secondary", secondary.text);
    }

    if (secondary.kind === "network" && secondary.timedOut) return fail("upstream_timeout");
    if (secondary.kind === "response" && secondary.status === 429) return fail("upstream_rate_limited");
    return fail("upstream_unavailable");
  } catch {
    return fail("upstream_unavailable");
  }
}
