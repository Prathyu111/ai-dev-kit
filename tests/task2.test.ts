import { afterEach, describe, expect, it } from "vitest";
import { authorize, extractRole, loadTokenMap } from "../src/task2/auth.js";
import { createDownstreamServer } from "../src/task2/downstream.js";
import { createGateway } from "../src/task2/gateway.js";
import { UNAUTHORIZED_TOOL_CALL } from "../src/task2/jsonrpc.js";
import { close, listen, postJson } from "./helpers.js";

const tokens = loadTokenMap({ MCP_GATEWAY_DEMO_TOKENS: "1" });
const servers: Array<import("node:http").Server> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => close(server)));
});

async function startPair() {
  const downstream = createDownstreamServer();
  const downstreamPort = await listen(downstream.server);
  const gateway = createGateway({
    downstreamUrl: `http://127.0.0.1:${downstreamPort}/mcp`,
    tokens,
  });
  const gatewayPort = await listen(gateway);
  servers.push(downstream.server, gateway);
  return {
    calls: downstream.calls,
    url: `http://127.0.0.1:${gatewayPort}/mcp`,
  };
}

describe("task 2 authorization", () => {
  it("reads bearer roles and blocks only admin_ tool calls for non-admins", () => {
    expect(extractRole("Bearer quilr_admin_demo", tokens)?.role).toBe("admin");
    expect(extractRole("bearer quilr_viewer_demo", tokens)?.role).toBe("viewer");
    expect(extractRole("Basic quilr_admin_demo", tokens)).toBeNull();
    expect(extractRole(undefined, tokens)).toBeNull();

    expect(authorize("viewer", "tools/list", undefined)).toEqual({ action: "forward" });
    expect(authorize("viewer", "tools/call", { name: "lookup_order" })).toEqual({ action: "forward" });
    expect(authorize("viewer", "tools/call", { name: "admin_reset_key" })).toMatchObject({
      action: "reject",
      code: UNAUTHORIZED_TOOL_CALL,
      message: "Unauthorized Tool Call",
    });
    expect(authorize("admin", "tools/call", { name: "admin_reset_key" })).toEqual({ action: "forward" });
    expect(authorize("viewer", "tools/call", { name: "Admin_reset_key" })).toEqual({ action: "forward" });
    expect(authorize("viewer", "tools/call", {})).toMatchObject({ code: -32602 });
  });
});

describe("task 2 gateway", () => {
  it("forwards tools/list unchanged and stops unauthorized admin calls before the downstream", async () => {
    const { url, calls } = await startPair();
    const listBody = {
      jsonrpc: "2.0",
      id: "list-1",
      method: "tools/list",
      params: {},
    };
    const listed = await postJson(url, listBody, { authorization: "Bearer quilr_viewer_demo" });
    expect(listed.status).toBe(200);
    expect(listed.json).toMatchObject({
      jsonrpc: "2.0",
      id: "list-1",
      result: { tools: expect.any(Array) },
    });
    const tools = (listed.json as { result: { tools: Array<{ name: string }> } }).result.tools.map((tool) => tool.name);
    expect(tools).toContain("admin_reset_key");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.raw).toBe(JSON.stringify(listBody));

    const denied = await postJson(
      url,
      { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "admin_reset_key", arguments: { key_id: "root" } } },
      { authorization: "Bearer quilr_viewer_demo" },
    );
    expect(denied.status).toBe(200);
    expect(denied.json).toEqual({
      jsonrpc: "2.0",
      id: 7,
      error: { code: UNAUTHORIZED_TOOL_CALL, message: "Unauthorized Tool Call" },
    });
    expect(calls).toHaveLength(1);

    const allowed = await postJson(
      url,
      { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "admin_reset_key", arguments: { key_id: "root" } } },
      { authorization: "Bearer quilr_admin_demo" },
    );
    expect(allowed.status).toBe(200);
    const toolText = (allowed.json as { result: { content: Array<{ text: string }> } }).result.content[0]?.text;
    expect(toolText).toContain('"reset":true');
    expect(calls.map((call) => call.tool)).toEqual([undefined, "admin_reset_key"]);

    const viewerTool = await postJson(
      url,
      { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "lookup_order", arguments: { order_id: "ORD-1" } } },
      { authorization: "Bearer quilr_viewer_demo" },
    );
    expect(viewerTool.status).toBe(200);
    expect(JSON.stringify(viewerTool.json)).toContain("ORD-1");
  });

  it("rejects missing credentials, bad JSON, and invalid tool params without forwarding", async () => {
    const { url, calls } = await startPair();
    const missing = await postJson(url, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(missing.status).toBe(401);
    expect(missing.json).toMatchObject({ error: { code: UNAUTHORIZED_TOOL_CALL, message: "Unauthorized" } });

    const badToken = await postJson(url, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "lookup_order" } }, {
      authorization: "Bearer not-a-token",
    });
    expect(badToken.status).toBe(401);

    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer quilr_admin_demo" },
      body: "{",
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: -32700, message: "Parse error" } });

    const invalid = await postJson(
      url,
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { arguments: {} } },
      { authorization: "Bearer quilr_admin_demo" },
    );
    expect(invalid.json).toMatchObject({ id: 4, error: { code: -32602, message: "Invalid params" } });
    expect(calls).toHaveLength(0);
  });
});
