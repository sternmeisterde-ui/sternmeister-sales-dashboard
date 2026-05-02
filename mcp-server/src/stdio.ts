/**
 * Stdio entry-point — for local dev (Claude Code) and golden-eval suite.
 * Runs as virtual admin context; no auth required.
 *
 * Usage: `npx tsx src/stdio.ts` from this package, or wire into Claude
 * Desktop via mcpServers config (see ../README.md).
 */

import * as dotenv from "dotenv";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createAdminContext, setCurrentContext } from "./auth/context.js";
import { createMcpServer } from "./server.js";
import { initSentry } from "./utils/trace.js";

// Load env from mcp-server/.env.local (not the default .env). For Claude
// Desktop integration, env vars are passed via the mcpServers config and
// this file load is a no-op; for local stdio dev (npx tsx src/stdio.ts)
// it picks up the dashboard's connection strings.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env.local") });
initSentry();

async function main() {
  // Stdio runs as virtual admin (single-user, local-dev). Set context BEFORE
  // server.connect so the registry's wrappers can read it on the first
  // tool call.
  setCurrentContext(createAdminContext());
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Process stays alive while transport is open. SIGTERM closes both.
}

main().catch((err) => {
  process.stderr.write(`[mcp-stdio] fatal: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
