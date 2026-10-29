function formatField(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
}

/** Operator logs. Always stderr, so an stdio MCP server can keep stdout for JSON-RPC. */
export function logError(scope: string, message: string, fields?: Record<string, unknown>): void {
  const payload: Record<string, unknown> = {
    ts: new Date().toISOString(),
    scope,
    message,
  };
  if (fields) {
    for (const [key, value] of Object.entries(fields)) {
      payload[key] = value;
    }
  }
  process.stderr.write(`${formatField(payload)}\n`);
}
