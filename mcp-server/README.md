# SternMeister MCP server

Curated domain-tool MCP server for the SternMeister sales dashboard. Lets
admins/РОПы query the data warehouse via Claude Desktop / Code without
writing SQL.

**Status**: Phase 2 — HTTP transport + bearer auth + Docker deploy ready. Two
domains landed (`managers` 5 tools, `okk` 6 tools). See
`../docs/MCP-IMPLEMENTATION-PLAN.md` for the full roadmap (Phases 3–5).

## Tools (live — 20 total)

- **discovery (3)** — `list_domains`, `describe_domain`, `glossary` (auto-loaded by Claude on connect)
- **managers (5)** — `managers.{list, find_by_name, get_profile, compare, find_outliers}`
- **okk (6)** — `okk.{summarise_quality, get_call, find_calls, top_problems, audit_overrides, coverage_heatmap}`
- **daily (3)** — `daily.{list_metrics, plan_vs_fact, refusals}`
- **analytics (3)** — `analytics.{scores_by_period, scores_by_manager, criterion_drift}`

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

## Production deploy (Dokploy → mcp.sternmeister.online)

The `mcp` service is added to the existing `docker-compose.yml`. Provision
in Dokploy:

1. **Domain**: `mcp.sternmeister.online` → port 3009 with TLS (Traefik does the cert).
2. **Env vars** (Dokploy UI):
   - `MCP_BEARER_TOKENS` — JSON array of token objects (see schema in `src/auth/tokens.ts`). One entry per user.
   - **Read-only DB URLs (REQUIRED for production)**: `MCP_D1_RO_URL`, `MCP_R1_RO_URL`, `MCP_D2_RO_URL`, `MCP_R2_RO_URL`, `MCP_ANALYTICS_RO_URL`, `MCP_TRACKING_RO_URL` — connect strings for dedicated `mcp_readonly` Postgres roles per Neon project. Without them, the server falls back to the dashboard's write-capable `DATABASE_URL` etc., which is **a security blocker for prod-deploy** — a compromised tool would have INSERT/UPDATE/DELETE on production. Provision the roles BEFORE pointing real users at this server.
   - `DATABASE_URL` — required for audit-log writes (`mcp_audit_log` lives in D1 and needs INSERT). Even with `MCP_*_RO_URL` in place, the audit path needs a write path. Use a dedicated `mcp_audit_writer` role with INSERT-only on `public.mcp_audit_log` if you want to lock this down further.
   - `MCP_SENTRY_DSN` — separate Sentry project `sternmeister-mcp-server` (optional but recommended).
   - `MCP_ALLOWED_ORIGINS` — comma-separated whitelist for browser-originated requests. Default: `https://mcp.sternmeister.online,https://claude.ai`. Non-browser clients (Claude Desktop, curl) skip this check entirely.
3. **Health**: GET `/health` returns 200 with status / uptime / session count / token count. Dokploy probes this.
4. **Auth**: every `/mcp` request needs `Authorization: Bearer <token>`. 401 otherwise.

### Token rotation

Manual, quarterly. Calendar trigger: set a recurring reminder in Dokploy
(or wherever your team's runbooks live) for the 1st of Jan/Apr/Jul/Oct.

**Procedure:**

```bash
# 1. Mint new tokens (script overwrites all USERS — re-run if user list changed)
npx tsx /Users/user/Dashbord/scripts/generate-mcp-tokens.ts > /tmp/mcp-tokens.json

# 2. Minify for Dokploy env
cat /tmp/mcp-tokens.json | python3 -c 'import json,sys;print(json.dumps(json.load(sys.stdin)))'

# 3. Paste output into Dokploy → mcp service → Environment → MCP_BEARER_TOKENS
# 4. Restart the mcp service
# 5. Verify
curl https://mcp.sternmeister.online/health
# → expects {"status":"ok","sessions":0,"version":"0.1.0",...}
# Check Dokploy logs:
#   [mcp-http] listening on :3009 — N bearer tokens loaded ← N matches USERS array length
#   [mcp-probe] D1: ok ([{"ok":1}]) ← all 6 must say "ok"

# 6. Distribute new snippets via Discord DM (script's stderr already prints them per user)
```

Old tokens become invalid immediately on restart — there is no overlap window.

**DB role rotation** is a separate concern — `mcp_readonly` Postgres password
rotation (different from bearer-token rotation). Run when the role's password
must be cycled (also quarterly, or after any leak):

```bash
node /Users/user/Dashbord/scripts/rotate-mcp-readonly.mjs --gen
# → Updates pwd on all 6 Neon branches + writes 6 fresh URLs to /tmp/mcp-ro-urls.env
cat /tmp/mcp-ro-urls.env  # 6 MCP_*_RO_URL lines → paste into Dokploy → restart
```

### Wiring into Claude Desktop (РОП setup)

Settings → Developer → Edit Config → add:

```json
{
  "mcpServers": {
    "sternmeister": {
      "url": "https://mcp.sternmeister.online/mcp",
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
├── domains/      curated tool sets (managers, okk, daily, analytics; looker/tracking/termin/roleplay in Phase 3)
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
