let installed = false;

function formatArg(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * stdout is reserved for MCP JSON-RPC frames. Redirect the console methods that
 * write to stdout so a stray log cannot corrupt the protocol stream.
 */
export function installStdoutGuard(): void {
  if (installed) return;
  installed = true;
  const redirect = (level: string) => (...args: unknown[]) => {
    process.stderr.write(`[stdout-guard:${level}] ${args.map(formatArg).join(" ")}\n`);
  };
  console.log = redirect("log");
  console.info = redirect("info");
  console.debug = redirect("debug");
}

installStdoutGuard();
