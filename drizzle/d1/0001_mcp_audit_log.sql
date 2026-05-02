-- =====================================================================
-- mcp_audit_log — append-only log of every MCP tool invocation.
-- Lives in D1 (DATABASE_URL). Written by mcp-server's audit middleware.
-- Apply once via Neon SQL editor or `npx tsx scripts/apply-mcp-audit-log.ts`.
-- =====================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.mcp_audit_log (
  id            BIGSERIAL PRIMARY KEY,
  ts            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  user_id       TEXT NOT NULL,         -- bearer-token claim
  user_role     TEXT NOT NULL,         -- 'admin' | 'rop' | 'manager'
  user_depts    TEXT[] NOT NULL,       -- ['b2g'] | ['b2b'] | ['b2g','b2b'] | ['*']
  transport     TEXT NOT NULL,         -- 'stdio' | 'http'
  tool_name     TEXT NOT NULL,         -- e.g. 'managers.list'
  tool_input    JSONB NOT NULL,        -- full input args (no secrets — bearer token NOT logged)
  duration_ms   INTEGER,
  rows_returned INTEGER,
  status        TEXT NOT NULL,         -- 'ok' | 'error' | 'denied'
  error_msg     TEXT,
  raw_sql       TEXT,                  -- only for sql.run_readonly escape hatch
  why           TEXT                   -- only for sql.run_readonly — required arg
);

COMMENT ON TABLE public.mcp_audit_log IS
  '[INTERNAL — MCP] Append-only лог каждого tool-вызова MCP-сервера. Записывается audit middleware. Питает /api/admin/mcp-stats и Sentry alerts (паттерн пробития, escape-hatch злоупотребления).';

COMMENT ON COLUMN public.mcp_audit_log.user_depts IS
  'Bearer-token claims: dept-scope. ''*'' для admin (все отделы).';

COMMENT ON COLUMN public.mcp_audit_log.tool_input IS
  'JSONB полного input — кроме секретов. Bearer-token НЕ логируется.';

COMMENT ON COLUMN public.mcp_audit_log.raw_sql IS
  'Только для sql.run_readonly escape hatch. NULL для curated tools.';

COMMENT ON COLUMN public.mcp_audit_log.why IS
  'Обязательный аргумент sql.run_readonly — почему понадобилось обойти curated. NULL для других tools.';

CREATE INDEX idx_mcp_audit_ts ON public.mcp_audit_log(ts DESC);
CREATE INDEX idx_mcp_audit_user ON public.mcp_audit_log(user_id, ts DESC);
CREATE INDEX idx_mcp_audit_tool ON public.mcp_audit_log(tool_name, ts DESC);
CREATE INDEX idx_mcp_audit_status ON public.mcp_audit_log(status) WHERE status <> 'ok';

COMMIT;
