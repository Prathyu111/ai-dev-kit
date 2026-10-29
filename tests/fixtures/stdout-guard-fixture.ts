import "../../src/task1/stdout-guard.ts";

console.log("leaked-token");
process.stderr.write("guard-active\n");
process.stdout.write('{"jsonrpc":"2.0","method":"ping"}\n');
