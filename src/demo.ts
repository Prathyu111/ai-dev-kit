import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { createDownstreamServer } from "./task2/downstream.js";
import { createGateway } from "./task2/gateway.js";
import { loadTokenMap } from "./task2/auth.js";
import { redactText, StreamingPiiRedactor } from "./task3/redactor.js";
import { createMockUpstream } from "./task4/mock-upstream.js";
import { closeUsageDatabase, openUsageDatabase, TokenRateLimiter } from "./task4/rate-limiter.js";
import { routeCompletion } from "./task4/router.js";
import { createCustomerServer } from "./task1/server.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function say(line = ""): void {
  process.stdout.write(`${line}\n`);
}

function listen(server: import("node:http").Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") resolve(address.port);
      else reject(new Error("missing port"));
    });
  });
}

async function task1(): Promise<void> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createCustomerServer();
  const client = new Client({ name: "demo", version: "1.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    const record = (await client.callTool({
      name: "get_customer_record",
      arguments: { customer_id: "CUST-10001" },
    })) as { content?: Array<{ type?: string; text?: string }> };
    const block = record.content?.[0];
    if (!block || block.type !== "text" || typeof block.text !== "string") throw new Error("expected text");
    say(`  get_customer_record CUST-10001 -> ${block.text}`);
    try {
      await client.callTool({ name: "get_customer_record", arguments: { customer_id: "CUST-12" } });
      throw new Error("invalid id should have failed");
    } catch (error) {
      const code = typeof error === "object" && error && "code" in error ? (error as { code: number }).code : undefined;
      if (code !== ErrorCode.InvalidParams) throw error;
      say(`  invalid customer_id -> JSON-RPC ${code} Invalid params`);
    }
  } finally {
    await client.close();
    await server.close();
  }
}

function shutdown(server: import("node:http").Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function task2(): Promise<void> {
  const downstream = createDownstreamServer();
  const downstreamPort = await listen(downstream.server);
  const live = createGateway({
    downstreamUrl: `http://127.0.0.1:${downstreamPort}/mcp`,
    tokens: loadTokenMap(),
  });
  const port = await listen(live);
  try {
    const call = async (token: string, name: string) => {
      const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { key_id: "root" } } }),
      });
      return response.json() as Promise<{ error?: { code: number; message: string }; result?: unknown }>;
    };
    const denied = await call("quilr_viewer_demo", "admin_reset_key");
    say(`  viewer admin_reset_key -> ${denied.error?.code} ${denied.error?.message} (downstream calls ${downstream.calls.length})`);
    const allowed = await call("quilr_admin_demo", "admin_reset_key");
    const toolText = (allowed.result as { content?: Array<{ text?: string }> } | undefined)?.content?.[0]?.text ?? "";
    const reset = toolText.includes('"reset":true');
    say(`  admin  admin_reset_key -> forwarded, downstream calls ${downstream.calls.length}, reset=${reset}`);
  } finally {
    await shutdown(live);
    await shutdown(downstream.server);
  }
}

function task3(): void {
  const text = "Email ada@quilr.ai about card 4111 1111 1111 1111 and SSN 123-45-6789.";
  const redactor = new StreamingPiiRedactor();
  let streamed = "";
  for (let index = 0; index < text.length; index += 4) {
    streamed += redactor.push(text.slice(index, index + 4));
  }
  streamed += redactor.flush();
  say(`  input:  ${text}`);
  say(`  output: ${streamed}`);
  if (streamed !== redactText(text) || streamed.includes("ada@quilr.ai")) {
    throw new Error("streaming redaction diverged");
  }
}

async function task4(): Promise<void> {
  const primary = createMockUpstream({ mode: "429" });
  const secondary = createMockUpstream({ mode: "ok" });
  const primaryPort = await listen(primary);
  const secondaryPort = await listen(secondary);
  const directory = mkdtempSync(join(tmpdir(), "quilr-demo-"));
  const db = openUsageDatabase(join(directory, "usage.sqlite"));
  const limiter = new TokenRateLimiter(db, { limit: 100, now: () => 1_000 });
  try {
    const body = { messages: [{ role: "user", content: "hello from the demo" }], max_tokens: 16, model: "quilr-primary" };
    const routed = await routeCompletion({
      rawBody: JSON.stringify(body),
      parsedBody: body,
      apiKey: "demo-tenant",
      limiter,
      primary: { url: `http://127.0.0.1:${primaryPort}/v1/chat/completions` },
      secondary: { url: `http://127.0.0.1:${secondaryPort}/v1/chat/completions`, model: "quilr-backup" },
      timeoutMs: 500,
    });
    say(`  primary 429 -> route ${routed.route}, model ${(routed.body as { model?: string }).model}`);
    const blocked = limiter.reserve("demo-tenant", 90);
    say(`  second reserve of 90 tokens with limit 100 -> ${blocked.ok ? "allowed" : blocked.reason}`);
  } finally {
    await shutdown(primary);
    await shutdown(secondary);
    closeUsageDatabase(db);
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

say("QuilrAI field assessment demo");
say("");
say("Task 1 — MCP server");
await task1();
say("");
say("Task 2 — MCP gateway");
await task2();
say("");
say("Task 3 — streaming PII redaction");
task3();
say("");
say("Task 4 — rate limit and model failover");
await task4();
say("");
say("Demo complete.");
