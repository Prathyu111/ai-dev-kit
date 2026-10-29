/**
 * Cross-platform launcher for commands that load node:sqlite.
 *
 * npm on Windows runs package scripts with cmd.exe, which cannot apply a
 * bash-style NODE_OPTIONS=... prefix. This file is executed by node itself,
 * sets that variable, then starts the requested local command.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

const flag = "--disable-warning=ExperimentalWarning";
const [command, ...args] = process.argv.slice(2);

if (command !== "vitest" && command !== "tsx") {
  console.error("usage: node scripts/run.mjs <vitest|tsx> [args...]");
  process.exit(1);
}

const existing = process.env.NODE_OPTIONS ?? "";
if (!existing.split(/\s+/).includes(flag)) {
  process.env.NODE_OPTIONS = [existing, flag].filter(Boolean).join(" ");
}

const packageJsonPath = require.resolve(`${command}/package.json`);
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
const binField = packageJson.bin;
const relativeBin = typeof binField === "string" ? binField : binField?.[command];
if (!relativeBin) {
  console.error(`could not resolve the ${command} executable`);
  process.exit(1);
}

const child = spawn(process.execPath, [flag, path.resolve(path.dirname(packageJsonPath), relativeBin), ...args], {
  stdio: "inherit",
  env: process.env,
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
