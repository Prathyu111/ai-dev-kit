import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getCustomer, listRefunds, triggerRefund } from "../src/task1/customers.js";
import { parseToolArguments } from "../src/task1/schemas.js";
import { createCustomerServer } from "../src/task1/server.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");

function tsxCommand(script: string): [string, string] {
  return [tsxCli, script];
}

async function withClient<T>(run: (client: Client) => Promise<T>): Promise<T> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createCustomerServer();
  const client = new Client({ name: "task1-test", version: "1.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    return await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

function textOf(result: unknown): string {
  if (!result || typeof result !== "object" || !("content" in result) || !Array.isArray(result.content)) {
    throw new Error("expected text content");
  }
  const block = result.content[0] as { type?: string; text?: string } | undefined;
  if (!block || block.type !== "text" || typeof block.text !== "string") {
    throw new Error("expected text content");
  }
  return block.text;
}

describe("task 1 validation", () => {
  it("accepts a well-formed customer id and refund", () => {
    const lookup = parseToolArguments("get_customer_record", { customer_id: "CUST-10001" });
    expect(lookup.ok).toBe(true);
    const refund = parseToolArguments("trigger_refund", {
      customer_id: "CUST-10002",
      amount: 12.5,
      reason: "  duplicate charge on the last invoice  ",
    });
    expect(refund.ok).toBe(true);
    if (refund.ok && refund.name === "trigger_refund") {
      expect(refund.data.reason).toBe("duplicate charge on the last invoice");
    }
  });

  it("rejects malformed ids, non-positive amounts, short reasons, and unknown fields", () => {
    const cases: Array<{ name: string; args: unknown; pattern: RegExp }> = [
      { name: "get_customer_record", args: { customer_id: "cust-10001" }, pattern: /CUST-XXXXX/ },
      { name: "get_customer_record", args: { customer_id: "CUST-1001" }, pattern: /CUST-XXXXX/ },
      { name: "get_customer_record", args: { customer_id: "CUST-100010" }, pattern: /CUST-XXXXX/ },
      { name: "get_customer_record", args: { customer_id: "CUST-ABCDE" }, pattern: /CUST-XXXXX/ },
      { name: "get_customer_record", args: {}, pattern: /customer_id/ },
      { name: "get_customer_record", args: { customer_id: "CUST-10001", extra: true }, pattern: /extra/i },
      { name: "trigger_refund", args: { customer_id: "CUST-10001", amount: 0, reason: "long enough reason" }, pattern: /amount/ },
      { name: "trigger_refund", args: { customer_id: "CUST-10001", amount: -4, reason: "long enough reason" }, pattern: /amount/ },
      { name: "trigger_refund", args: { customer_id: "CUST-10001", amount: "10", reason: "long enough reason" }, pattern: /amount/ },
      { name: "trigger_refund", args: { customer_id: "CUST-10001", amount: 10, reason: "too short" }, pattern: /reason/ },
      { name: "trigger_refund", args: { customer_id: "CUST-10001", amount: 10, reason: "          " }, pattern: /reason/ },
    ];
    for (const testCase of cases) {
      const parsed = parseToolArguments(testCase.name, testCase.args);
      expect(parsed.ok, JSON.stringify(testCase.args)).toBe(false);
      if (!parsed.ok) expect(parsed.message).toMatch(testCase.pattern);
    }
  });

  it("returns a tool error for an unknown or closed customer without treating it as a schema failure", () => {
    expect(getCustomer("CUST-99999")).toBeUndefined();
    const missing = triggerRefund({
      customer_id: "CUST-99999",
      amount: 5,
      reason: "customer was double charged",
    });
    expect(missing.ok).toBe(false);
    const closed = triggerRefund({
      customer_id: "CUST-10004",
      amount: 5,
      reason: "customer was double charged",
    });
    expect(closed.ok).toBe(false);
  });
});

describe("task 1 MCP protocol", () => {
  it("lists both tools and maps invalid input to JSON-RPC -32602", async () => {
    await withClient(async (client) => {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual(["get_customer_record", "trigger_refund"]);
      const schema = listed.tools[0]?.inputSchema as { properties?: Record<string, { pattern?: string }> };
      expect(schema.properties?.customer_id?.pattern).toBe("^CUST-\\d{5}$");

      await expect(
        client.callTool({ name: "get_customer_record", arguments: { customer_id: "nope" } }),
      ).rejects.toMatchObject({ code: ErrorCode.InvalidParams });

      await expect(
        client.callTool({
          name: "trigger_refund",
          arguments: { customer_id: "CUST-10001", amount: -1, reason: "short" },
        }),
      ).rejects.toMatchObject({ code: ErrorCode.InvalidParams });

      await expect(client.callTool({ name: "missing_tool", arguments: {} })).rejects.toMatchObject({
        code: ErrorCode.InvalidParams,
      });
    });
  });

  it("returns customer records and queues a refund", async () => {
    await withClient(async (client) => {
      const record = await client.callTool({
        name: "get_customer_record",
        arguments: { customer_id: "CUST-10001" },
      });
      expect(record.isError).not.toBe(true);
      expect(JSON.parse(textOf(record)).name).toBe("Avery Chen");

      const missing = await client.callTool({
        name: "get_customer_record",
        arguments: { customer_id: "CUST-99999" },
      });
      expect(missing.isError).toBe(true);

      const before = listRefunds().length;
      const refund = await client.callTool({
        name: "trigger_refund",
        arguments: {
          customer_id: "CUST-10001",
          amount: 18.25,
          reason: "duplicate subscription charge",
        },
      });
      expect(refund.isError).not.toBe(true);
      const body = JSON.parse(textOf(refund)) as { refund_id: string; amount: number; reason: string };
      expect(body.refund_id).toMatch(/^RFD-/);
      expect(body.amount).toBe(18.25);
      expect(body.reason).toBe("duplicate subscription charge");
      expect(listRefunds().length).toBe(before + 1);
    });
  });
});

describe("task 1 stdio isolation", () => {
  it("keeps stdout limited to JSON-RPC frames and writes logs to stderr", async () => {
    const child = spawn(process.execPath, tsxCommand("src/task1/main.ts"), {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const messages: unknown[] = [];
    let buffer = "";
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out\nstderr=${stderr}\nbuffer=${buffer}`)), 8_000);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        buffer += chunk;
        let newline = buffer.indexOf("\n");
        while (newline !== -1) {
          const line = buffer.slice(0, newline).replace(/\r$/, "");
          buffer = buffer.slice(newline + 1);
          if (line.length > 0) {
            messages.push(JSON.parse(line));
            if (messages.length >= 4) {
              clearTimeout(timer);
              resolve();
              return;
            }
          }
          newline = buffer.indexOf("\n");
        }
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`server exited ${code}\nstderr=${stderr}`));
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });

    const send = (message: unknown) => {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "stdout-probe", version: "1.0.0" },
      },
    });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    send({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "get_customer_record", arguments: { customer_id: "BAD" } },
    });
    send({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "get_customer_record", arguments: { customer_id: "CUST-10003" } },
    });

    try {
      await ready;
    } finally {
      child.kill();
      await Promise.race([
        once(child, "exit").catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 2_000)),
      ]);
    }

    expect(buffer.trim()).toBe("");
    for (const message of messages) {
      expect(message).toMatchObject({ jsonrpc: "2.0" });
    }
    const byId = new Map(messages.map((message) => [(message as { id?: number }).id, message]));
    expect(byId.get(3)).toMatchObject({
      error: { code: ErrorCode.InvalidParams },
    });
    expect(JSON.stringify(byId.get(4))).toContain("Sam Okonkwo");
    expect(stderr).toContain("customer-ops");
    expect(JSON.stringify(messages)).not.toContain("stdio server ready");
  });

  it("redirects console.log to stderr", async () => {
    const child = spawn(process.execPath, tsxCommand("tests/fixtures/stdout-guard-fixture.ts"), {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const code = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (exitCode) => resolve(exitCode ?? 1));
    });
    expect(code).toBe(0);
    expect(stdout.trim()).toBe('{"jsonrpc":"2.0","method":"ping"}');
    expect(stdout).not.toContain("leaked-token");
    expect(stderr).toContain("leaked-token");
    expect(stderr).toContain("guard-active");
  });
});
