import "./stdout-guard.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { logError } from "../shared/logger.js";
import { createCustomerServer } from "./server.js";

const server = createCustomerServer();

server.connect(new StdioServerTransport()).then(
  () => {
    logError("customer-ops", "stdio server ready");
  },
  () => {
    logError("customer-ops", "failed to start stdio server");
    process.exit(1);
  },
);
