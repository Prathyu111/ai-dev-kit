/**
 * Cross-platform launcher for commands that load node:sqlite.
 *
 * npm on Windows runs package scripts with cmd.exe, which cannot apply a
 * bash-style NODE_OPTIONS=... prefix. This file is executed by node itself,
 * sets that variable, then starts the requested local command.
 */
import { spawn } from "node:child_process";

const flag = "--disable-warning=ExperimentalWarning";
const [command, ...args] = process.argv.slice(2);

if (!command) {
  console.error("usage: node scripts/run.mjs <command> [args...]");
  process.exit(1);
}

const existing = process.env.NODE_OPTIONS ?? "";
if (!existing.split(/\s+/).includes(flag)) {
  process.env.NODE_OPTIONS = [existing, flag].filter(Boolean).join(" ");
}

const child = spawn(command, args, {
  stdio: "inherit",
  env: process.env,
  shell: true,
});

child.on("error", (error) => {
  console.error(error);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
