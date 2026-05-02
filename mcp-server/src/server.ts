/**
 * MCP server factory — assembles the registry, applies auth/audit middleware,
 * registers domain tools and resources. Returns an unconnected McpServer
 * ready to be bound to a transport (stdio or HTTP).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { registerDiscovery } from "./registry/discovery.js";
import { registerManagersDomain } from "./domains/managers/tools.js";
import { registerOkkDomain } from "./domains/okk/tools.js";
import { registerDailyDomain } from "./domains/daily/tools.js";
import { registerAnalyticsDomain } from "./domains/analytics/tools.js";

const SERVER_INFO = {
  name: "sternmeister-mcp-server",
  version: "0.1.0",
} as const;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createMcpServer(): McpServer {
  const server = new McpServer(SERVER_INFO, {
    capabilities: {
      tools: {},
      resources: {},
    },
  });

  registerDiscovery(server);
  registerManagersDomain(server);
  registerOkkDomain(server);
  registerDailyDomain(server);
  registerAnalyticsDomain(server);

  // Bundle markdown resources (auto-loaded by Claude Desktop on connect).
  registerResource(server, "mcp://glossary", "glossary.md", "text/markdown",
    "Бизнес-словарь проекта: D1/R1/D2/R2, B2G/B2B, ROP, SLA, TLT, Pattern A, etc.");
  registerResource(server, "mcp://playbook-rop", "playbook-rop.md", "text/markdown",
    "Playbook для РОПа: типовые вопросы → рекомендуемые tool-цепочки.");

  return server;
}

function registerResource(
  server: McpServer,
  uri: string,
  filename: string,
  mimeType: string,
  description: string,
): void {
  server.registerResource(
    filename.replace(/\.md$/, ""),
    uri,
    {
      title: filename,
      description,
      mimeType,
    },
    async () => {
      const file = path.join(__dirname, "resources", filename);
      const text = await fs.readFile(file, "utf8");
      return {
        contents: [
          {
            uri,
            mimeType,
            text,
          },
        ],
      };
    },
  );
}
