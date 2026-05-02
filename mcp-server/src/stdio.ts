/**
 * Stdio entry-point — for local dev (Claude Code) and golden-eval suite.
 * Runs as virtual admin context; no auth required.
 *
 * Usage: `npx tsx src/stdio.ts` from this package, or wire into Claude
 * Desktop via mcpServers config (see ../README.md).
 */

import "dotenv/config";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createMcpServer } from "./server.js";

async function main() {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Process stays alive while transport is open. SIGTERM closes both.
}

main().catch((err) => {
  process.stderr.write(`[mcp-stdio] fatal: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
