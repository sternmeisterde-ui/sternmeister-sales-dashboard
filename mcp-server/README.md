# SternMeister MCP server

Curated domain-tool MCP server for the SternMeister sales dashboard. Lets
admins/РОПы query the data warehouse via Claude Desktop / Code without
writing SQL.

**Status**: Phase 2 — HTTP transport + bearer auth + Docker deploy ready. Two
domains landed (`managers` 5 tools, `okk` 6 tools). See
`../docs/MCP-IMPLEMENTATION-PLAN.md` for the full roadmap (Phases 3–5).

## Tools (live)

- **discovery** — `list_domains`, `describe_domain`, `glossary` (auto-loaded by Claude on connect)
- **managers** — `managers.{list, find_by_name, get_profile, compare, find_outliers}`
- **okk** — `okk.{summarise_quality, get_call, find_calls, top_problems, audit_overrides, coverage_heatmap}`

## Local dev (stdio, no auth)

```bash
cd mcp-server
npm install
cp ../.env.local .env.local        # reuse dashboard's DB URLs
npx tsx src/stdio.ts                # serves on stdio (no port)
```

Smoke from another terminal:

```bash
(printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"1"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"glossary","arguments":{"term":"d1"}}}' \
  ; sleep 3) | npx tsx src/stdio.ts
```

### Wiring stdio into Claude Code

Add to `~/.claude.json`:

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

## Local HTTP (bearer auth)

```bash
cd mcp-server
MCP_BEARER_TOKENS='[{"token":"sk-mcp-test-1234567890123456","userId":"local","name":"Dev","role":"admin","depts":["*"],"issued":"2026-05-02"}]' \
  npx tsx src/index.ts
# listening on :3009
```

Smoke:

```bash
curl -s http://localhost:3009/health
# → {"status":"ok","version":"0.1.0",…}

TOK="sk-mcp-test-1234567890123456"
INIT_RESP=$(curl -s -i -X POST http://localhost:3009/mcp \
  -H "Authorization: Bearer $TOK" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}')

SID=$(echo "$INIT_RESP" | grep -i "mcp-session-id:" | awk '{print $2}' | tr -d '\r')

curl -s -X POST http://localhost:3009/mcp \
  -H "Authorization: Bearer $TOK" \
  -H "Mcp-Session-Id: $SID" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}' >/dev/null

curl -s -X POST http://localhost:3009/mcp \
  -H "Authorization: Bearer $TOK" \
  -H "Mcp-Session-Id: $SID" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"managers.find_by_name","arguments":{"name":"Дмитрий","dept":"b2g"}}}'
```

## Production deploy (Dokploy → mcp.sternmeister.de)

The `mcp` service is added to the existing `docker-compose.yml`. Provision
in Dokploy:

1. **Domain**: `mcp.sternmeister.de` → port 3009 with TLS (Traefik does the cert).
2. **Env vars** (Dokploy UI):
   - `MCP_BEARER_TOKENS` — JSON array of token objects (see schema in `src/auth/tokens.ts`). One entry per user.
   - `DATABASE_URL`, `R1_DATABASE_URL`, `D2_OKK_DATABASE_URL`, `R2_OKK_DATABASE_URL`, `ANALYTICS_DATABASE_URL`, `TRACKING_DATABASE_URL` — same as dashboard's (Phase 2 reuse). Phase 3 swaps to `MCP_*_RO_URL` against dedicated `mcp_readonly_*` Postgres roles.
   - `MCP_SENTRY_DSN` — separate Sentry project `sternmeister-mcp-server` (optional but recommended).
3. **Health**: GET `/health` returns 200 with status / uptime / session count / token count. Dokploy probes this.
4. **Auth**: every `/mcp` request needs `Authorization: Bearer <token>`. 401 otherwise.

### Token rotation

Manual, quarterly. Generate with `openssl rand -hex 24` (prepend `sk-mcp-`),
update `MCP_BEARER_TOKENS` in Dokploy, restart `mcp` service. Old token
becomes invalid immediately on restart.

### Wiring into Claude Desktop (РОП setup)

Settings → Developer → Edit Config → add:

```json
{
  "mcpServers": {
    "sternmeister": {
      "url": "https://mcp.sternmeister.de/mcp",
      "headers": {
        "Authorization": "Bearer sk-mcp-<your-token>"
      }
    }
  }
}
```

Restart Claude Desktop. The agent should auto-load `glossary`, `playbook-rop`,
and the 14 tools on first message.

## Layout

```
src/
├── auth/         bearer-token store, per-request context (ALS), role/dept gates
├── db/           6 read-only Neon connections + audit-log middleware + query guards
├── registry/     discovery (list_domains, describe_domain, glossary) + tool wrapper
├── domains/      curated tool sets (managers, okk; daily/analytics in Phase 3)
├── resources/    auto-loaded MD resources (glossary, playbook-rop)
├── utils/        Sentry init, error capture
├── server.ts     factory: assembles registry + auth + audit + 2 markdown resources
├── stdio.ts      entry-point: stdio transport
└── index.ts      entry-point: HTTP streamable transport (bearer auth + sessions)
```

## Audit log

Every tool invocation lands in `D1.mcp_audit_log` (same Neon project as the
dashboard's `master_managers`). Schema in `../drizzle/d1/0001_mcp_audit_log.sql`.
Inspect:

```sql
SELECT tool_name, transport, user_id, status, duration_ms, rows_returned, ts
FROM mcp_audit_log
ORDER BY ts DESC
LIMIT 50;

-- error patterns
SELECT tool_name, COUNT(*) FROM mcp_audit_log WHERE status='error'
  AND ts > NOW() - INTERVAL '24 hours'
GROUP BY 1 ORDER BY 2 DESC;

-- escape-hatch usage (Phase 4)
SELECT user_id, why, raw_sql FROM mcp_audit_log
WHERE tool_name='sql.run_readonly' AND ts > NOW() - INTERVAL '7 days';
```

## Tests

```bash
npm run typecheck       # tsc --noEmit, 0 errors expected
# unit / golden suite — Phase 4
```
