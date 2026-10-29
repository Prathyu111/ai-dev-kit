# QuilrAI field assessment

Hands-on slice for the AI Field Developer / Solutions Engineer loop: a stdio MCP server, an MCP security gateway, a streaming LLM guardrail, and a SQLite-backed model router.

Node.js 22.5 or newer (uses `node:sqlite`). No external services.

```bash
npm install
npm test
npm run typecheck
npm run demo
```

## Layout

| Path | Task |
| --- | --- |
| `src/task1` | MCP server, stdio transport, Zod validation |
| `src/task2` | Bearer-role MCP gateway and mock downstream |
| `src/task3` | Streaming PII redactor and LLM gateway |
| `src/task4` | Sliding-window token limiter, failover router, on-disk SQLite |
| `tests` | Protocol, auth, stream, and failover coverage |

Logs go to stderr. The MCP server never writes ordinary logs to stdout.

## Task 1 — MCP server

Stdio server built on `@modelcontextprotocol/sdk`. Tools:

- `get_customer_record` — `customer_id` must match `CUST-XXXXX` (five digits), for example `CUST-10001`.
- `trigger_refund` — same customer id, a positive finite `amount`, and a `reason` of at least 10 characters. Whitespace-only reasons are rejected. Unknown object keys are rejected.

Invalid input is a JSON-RPC error `-32602` (`Invalid params`), not a successful tool result with `isError: true`. The high-level `McpServer.registerTool` helper catches that failure and turns it into the tool result, so this server uses the SDK's low-level `Server` and rejects the call on the JSON-RPC error channel. A missing or closed customer is a real tool result (`isError: true`): the arguments were valid, the business call was not.

`src/task1/stdout-guard.ts` redirects `console.log`, `console.info`, and `console.debug` to stderr before the transport starts. The SDK writes newline-delimited JSON-RPC to stdout.

```bash
npm run task1:call -- get_customer_record '{"customer_id":"CUST-10001"}'
npm run task1:call -- trigger_refund '{"customer_id":"CUST-10001","amount":12.5,"reason":"duplicate subscription charge"}'
```

Records shipped with the server: `CUST-10001` Avery Chen, `CUST-10002` Jordan Blake, `CUST-10003` Sam Okonkwo, `CUST-10004` Riley Nguyen (closed). The email addresses are fictional fixtures.

## Task 2 — MCP security gateway

`POST /mcp` on the gateway (default `127.0.0.1:43122`) in front of a mock MCP server (default `127.0.0.1:43121`).

Demo tokens:

| Token | Role |
| --- | --- |
| `quilr_admin_demo` | admin |
| `quilr_viewer_demo` | viewer |

Add more with `MCP_GATEWAY_TOKENS=token:admin,token:viewer`. Set `MCP_GATEWAY_DEMO_TOKENS=0` to disable the demo pair.

Policy:

- A valid bearer token is required. Missing or unknown tokens get HTTP 401 and JSON-RPC `-32001` / `Unauthorized`, and the downstream is not called.
- `tools/list` is forwarded as-is for both roles. Admin tool names stay visible. Filtering the catalog was not part of the task.
- `tools/call` whose `params.name` starts with `admin_` (case-sensitive) is forwarded only for `admin`. Otherwise the gateway returns HTTP 200 and this body, without calling downstream:

```json
{ "jsonrpc": "2.0", "id": 1, "error": { "code": -32001, "message": "Unauthorized Tool Call" } }
```

- Other authenticated methods (`tools/call` for ordinary tools, `initialize`, `ping`) are forwarded. The original request bytes are proxied. The `Authorization` header is not forwarded.
- Downstream failures become `-32603` / `Downstream MCP server unavailable` with no upstream error text.

```bash
npm run task2:downstream
npm run task2:gateway
```

```bash
curl -s http://127.0.0.1:43122/mcp \
  -H 'authorization: Bearer quilr_viewer_demo' \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"admin_reset_key","arguments":{"key_id":"root"}}}'
```

The mock records calls at `GET /_meta/calls` so you can see a denied tool never arrived.

## Task 3 — streaming PII guardrail

`POST /v1/chat/completions` (default `127.0.0.1:43132`) proxies an OpenAI-style provider (mock default `127.0.0.1:43131`).

The redactor masks:

- emails
- SSNs shaped like `123-45-6789`
- card numbers of 13–19 digits, optional single spaces or dashes, that pass the Luhn check and start with 3, 4, 5, or 6

Matches are replaced with `[REDACTED]`. Ordinary values such as `order 12345` and `2026-10-29` are left alone. A 16-digit number that fails Luhn is left alone.

Streaming does not buffer the completion. Each chunk is appended to a small tail. The tail is only the trailing email candidate (local-part, or `local@domain`, at most 512 characters) or the trailing card/SSN run (at most 19 digits). Everything before that tail is redacted and written immediately, which keeps time-to-first-token down to a delimiter for normal prose. `flush()` runs on `[DONE]`, on `finish_reason`, and when the upstream stream ends, so a secret that is still open at the end is still masked. One redactor is kept per `choices[].index`, so a secret split across SSE events is still caught.

Non-streaming responses (`"stream": false`) redact `choices[].message.content` in one pass. Upstream HTTP errors are replaced with a gateway error and the provider body is discarded.

```bash
npm run task3:provider
UPSTREAM_URL=http://127.0.0.1:43131/v1/chat/completions npm run task3:gateway
```

```bash
curl -N http://127.0.0.1:43132/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"stream":true,"messages":[{"role":"user","content":"Summarize the account."}]}'
```

The mock streams a canned completion that contains an email, an SSN, and a test card, five characters at a time.

## Task 4 — rate limit and model failover

`POST /v1/chat/completions` (default `127.0.0.1:43143`).

Token budget: **50,000 tokens per minute per API key**, sliding window, stored in on-disk SQLite (`SQLITE_PATH`, default `data/usage.sqlite`). The raw API key is not stored; the row key is its SHA-256. Each reserve runs in `BEGIN IMMEDIATE`, deletes rows older than the window, then inserts. Two processes cannot both admit the same last token.

The estimate is `ceil(prompt characters / 4) + max_tokens` (or `max_completion_tokens`). That reservation is taken before the upstream call so concurrent requests cannot overshoot. If the provider returns `usage.total_tokens`, the row is updated to the reported total. If the gateway fails the request, the reservation is deleted.

Failover, and only these cases:

- primary responds `429`
- primary does not finish within **3000 ms**

A primary `500`, or a connection failure that is not a timeout, does not fail over. When the primary call is a timeout or a 429, the secondary provider is tried with its own 3000 ms budget. `SECONDARY_MODEL` rewrites the `model` field on that attempt.

Error responses use a fixed payload. Upstream bodies, stack traces, and internal URLs are not copied through:

```json
{
  "error": {
    "type": "gateway_error",
    "code": "upstream_unavailable",
    "message": "The model provider could not complete the request.",
    "request_id": "..."
  }
}
```

Codes: `rate_limit_exceeded` (429), `request_exceeds_limit` (400), `unauthorized` (401), `invalid_request` (400), `upstream_timeout` (504), `upstream_rate_limited` (429), `upstream_unavailable` (502).

```bash
PORT=43141 MODE=429 npm run task4:primary
PORT=43142 MODE=ok npm run task4:secondary
PRIMARY_URL=http://127.0.0.1:43141/v1/chat/completions \
SECONDARY_URL=http://127.0.0.1:43142/v1/chat/completions \
SECONDARY_MODEL=quilr-backup \
npm run task4:gateway
```

```bash
curl -s http://127.0.0.1:43143/v1/chat/completions \
  -H 'authorization: Bearer tenant-demo' \
  -H 'content-type: application/json' \
  -d '{"model":"quilr-primary","messages":[{"role":"user","content":"hello"}],"max_tokens":32}'
```

`MODE` on the mock upstream is `ok`, `429`, `500`, or `hang`. Success responses include `X-Model-Route: primary|secondary`.

## Assumptions

- `CUST-XXXXX` means `CUST-` plus exactly five digits.
- `admin_` is a case-sensitive prefix. `tools/list` is not filtered.
- JSON-RPC batches are rejected as invalid requests. Every proxied call has an id.
- Card redaction requires Luhn plus a leading digit 3–6, so a random long number is not masked.
- The streaming hold is at most one trailing token. A delimiter (space, punctuation outside the token) releases it. That is the latency tradeoff that still catches secrets split across chunks.
- Failover follows the brief: `429` and a 3000 ms timeout. Other upstream failures are sanitized and returned.
- The API key is `Authorization: Bearer <key>` or `X-API-Key`.
