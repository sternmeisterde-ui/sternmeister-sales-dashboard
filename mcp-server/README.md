# SternMeister MCP server

Curated domain-tool MCP server for the SternMeister sales dashboard. Lets
admins/РОПы query the data warehouse via Claude Desktop / Code without
writing SQL.

**Status**: Phase 1a — scaffold + discovery layer. Domain tools land in 1b.
See `../docs/MCP-IMPLEMENTATION-PLAN.md` for full roadmap.

## Local dev (stdio, no auth)

```bash
cd mcp-server
npm install
cp ../.env.local .env.local        # reuse dashboard's DB URLs
npx tsx src/stdio.ts                # serves on stdio (no port)
```

Wire into Claude Code via `~/.claude.json` `mcpServers`:

```json
{
  "mcpServers": {
    "sternmeister": {
      "command": "npx",
      "args": ["-y", "tsx", "/Users/user/Dashbord/mcp-server/src/stdio.ts"],
      "env": {
        "DATABASE_URL": "postgres://…",
        "R1_DATABASE_URL": "postgres://…",
        "D2_OKK_DATABASE_URL": "postgres://…",
        "R2_OKK_DATABASE_URL": "postgres://…",
        "ANALYTICS_DATABASE_URL": "postgres://…",
        "TRACKING_DATABASE_URL": "postgres://…"
      }
    }
  }
}
```

## Production HTTP (Phase 2)

To be deployed at `mcp.sternmeister.de` via Dokploy. Bearer-token auth via
`MCP_BEARER_TOKENS` env. See `../docs/MCP-IMPLEMENTATION-PLAN.md` §3, §7.

## Layout

```
src/
├── auth/         bearer-token store, per-request context, role/dept gates
├── db/           6 read-only Neon connections + audit-log middleware + query guards
├── registry/     discovery (list_domains, describe_domain, glossary)
├── domains/      curated tool sets (managers, okk, roleplay, daily, …)
├── resources/    auto-loaded MD resources (glossary, architecture, playbook)
├── server.ts     factory: assembles registry + auth + audit
├── stdio.ts      entry-point: stdio transport
└── index.ts      entry-point: HTTP streamable transport (Phase 2)
```

## Tests

```bash
npm test                # unit
npm run eval            # golden Q&A suite (Phase 4)
```
