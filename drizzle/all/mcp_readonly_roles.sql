-- =====================================================================
-- MCP read-only Postgres roles — applies separately to EACH of 6 Neon DBs.
--
-- Apply via Neon SQL editor for each project (D1, R1, D2, R2, Analytics,
-- Tracking) — same SQL works on all because the table-list is per-DB
-- conditional (NOT EXISTS guards skip absent tables).
--
-- ⚠️  BEFORE PASTING INTO NEON SQL EDITOR:
--     Replace ALL occurrences of `__MCP_PASSWORD__` with a strong password
--     (e.g. `openssl rand -hex 32`). The Neon SQL editor does NOT expand
--     psql client-side variables, so the substitution must happen by hand.
--     Use the SAME password on all 6 DBs (one role × one password × 6 DSNs).
--
-- Why: Phase 2 currently uses dashboard's write-capable DSN. Phase 3 must
-- pin DB access to a dedicated `mcp_readonly` role with SELECT-only on
-- analytical tables and INSERT-only on mcp_audit_log (D1 only).
--
-- Steps after apply:
--   1. neon_owner@<db>$ \du  → confirm `mcp_readonly` exists
--   2. Set MCP_*_RO_URL env in Dokploy with the new DSN, format:
--      postgresql://mcp_readonly:<password>@<host>/<dbname>?sslmode=require
--   3. Restart mcp service
--   4. Smoke: tool call should still work; INSERT to a non-audit table
--      should now fail with 'permission denied'.
--
-- Token rotation: ALTER ROLE mcp_readonly PASSWORD '<new>'; restart mcp.
-- =====================================================================

BEGIN;

-- Idempotent role creation (Neon doesn't support CREATE ROLE IF NOT EXISTS,
-- workaround via DO block + pg_roles check). Password substituted by hand
-- (see header note about __MCP_PASSWORD__).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mcp_readonly') THEN
    CREATE ROLE mcp_readonly WITH LOGIN PASSWORD '__MCP_PASSWORD__';
  END IF;
END$$;

-- Per-role defaults to keep MCP queries cheap and bounded.
ALTER ROLE mcp_readonly SET statement_timeout = '10s';
ALTER ROLE mcp_readonly SET idle_in_transaction_session_timeout = '30s';
ALTER ROLE mcp_readonly SET work_mem = '32MB';

-- Connect privilege. `current_database()` is a function — must be wrapped
-- in EXECUTE format() since GRANT ... ON DATABASE requires an identifier.
DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO mcp_readonly', current_database());
END$$;

-- Schema USAGE — public is always present; analytics only on Analytics DB.
GRANT USAGE ON SCHEMA public TO mcp_readonly;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'analytics') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA analytics TO mcp_readonly';
  END IF;
END$$;

-- SELECT on EVERY existing table in public (and analytics where present).
-- We grant broadly; the pg COMMENTs already mark internal/legacy/PII tables
-- so the MCP agent skips them by tool design rather than DB enforcement.
GRANT SELECT ON ALL TABLES IN SCHEMA public TO mcp_readonly;
-- ALTER DEFAULT PRIVILEGES applies only to objects created by the role
-- running this script. Neon's default table owner is `neondb_owner`; pin
-- explicitly so future tables (created by ETL or Drizzle migrations
-- running as that role) auto-grant SELECT to mcp_readonly. If the per-DB
-- owner differs, change the role name in `FOR ROLE`.
ALTER DEFAULT PRIVILEGES FOR ROLE neondb_owner IN SCHEMA public
  GRANT SELECT ON TABLES TO mcp_readonly;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'analytics') THEN
    EXECUTE 'GRANT SELECT ON ALL TABLES IN SCHEMA analytics TO mcp_readonly';
    EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE neondb_owner IN SCHEMA analytics GRANT SELECT ON TABLES TO mcp_readonly';
  END IF;
END$$;

-- Audit log: INSERT-only on mcp_audit_log (D1 only — table doesn't exist
-- on other DBs, so the GRANT silently no-ops via the EXISTS guard).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON c.relnamespace = n.oid
    WHERE n.nspname = 'public' AND c.relname = 'mcp_audit_log'
  ) THEN
    EXECUTE 'GRANT INSERT ON public.mcp_audit_log TO mcp_readonly';
    EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE public.mcp_audit_log_id_seq TO mcp_readonly';
  END IF;
END$$;

-- Explicit revokes — paranoia: ensure no DML besides what's granted above.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA public FROM mcp_readonly;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'analytics') THEN
    EXECUTE 'REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA analytics FROM mcp_readonly';
  END IF;
END$$;

-- Re-grant the audit-only INSERT (above REVOKE was broad).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON c.relnamespace = n.oid
    WHERE n.nspname = 'public' AND c.relname = 'mcp_audit_log'
  ) THEN
    EXECUTE 'GRANT INSERT ON public.mcp_audit_log TO mcp_readonly';
  END IF;
END$$;

COMMIT;

-- Smoke (run as mcp_readonly):
--   SELECT count(*) FROM master_managers;       -- should work on D1
--   INSERT INTO master_managers (...) VALUES (...);  -- should FAIL: permission denied
