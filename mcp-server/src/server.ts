/**
 * MCP server factory — assembles the registry, applies auth/audit middleware,
 * registers domain tools and resources. Returns an unconnected McpServer
 * ready to be bound to a transport (stdio or HTTP).
 *
 * Phase 1 scope: discovery layer only. Domain tools (managers, okk) load
 * via separate registerDomain() calls in Phase 1b.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const SERVER_INFO = {
  name: "sternmeister-mcp-server",
  version: "0.1.0",
} as const;

export function createMcpServer(): McpServer {
  const server = new McpServer(SERVER_INFO, {
    capabilities: {
      tools: {},
      resources: {},
    },
  });

  // Phase 1a: discovery + resources only. Domain tools wire in Phase 1b.
  // (registerDiscovery, registerManagersDomain, registerOkkDomain — TODO)

  return server;
}
