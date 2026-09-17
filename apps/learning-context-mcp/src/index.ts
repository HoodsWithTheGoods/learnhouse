import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { loadRuntimeConfiguration } from "./config.js";
import { LearningContextService } from "./service.js";
import { createLearningContextMcpServer } from "./server.js";

async function main(): Promise<void> {
  const configuration = loadRuntimeConfiguration();
  const server = createLearningContextMcpServer(new LearningContextService(configuration));
  await server.connect(new StdioServerTransport());
}

void main().catch(() => {
  // STDIO carries only MCP protocol messages. Configuration values never go to stdout.
  process.exitCode = 1;
});
