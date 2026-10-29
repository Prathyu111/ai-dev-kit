import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";

const tool = process.argv[2];
const argsJson = process.argv[3] ?? "{}";

if (!tool) {
  process.stderr.write("usage: npm run task1:call -- <tool> '<json-arguments>'\n");
  process.exit(1);
}

let args: Record<string, unknown>;
try {
  const parsed = JSON.parse(argsJson) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("arguments must be a JSON object");
  }
  args = parsed as Record<string, unknown>;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const serverPath = fileURLToPath(new URL("./main.ts", import.meta.url));
const tsxBin = fileURLToPath(new URL("../../node_modules/.bin/tsx", import.meta.url));
const transport = new StdioClientTransport({
  command: tsxBin,
  args: [serverPath],
  stderr: "inherit",
  cwd: fileURLToPath(new URL("../..", import.meta.url)),
});
const client = new Client({ name: "quilr-task1-cli", version: "1.0.0" });

await client.connect(transport);
try {
  const result = await client.callTool({ name: tool, arguments: args });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.isError) process.exitCode = 2;
} catch (error) {
  const code = typeof error === "object" && error && "code" in error ? (error as { code: unknown }).code : undefined;
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${JSON.stringify({ code, message })}\n`);
  process.exitCode = 1;
} finally {
  await client.close();
}
