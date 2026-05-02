-- =====================================================================
-- Phase 2 review-driven index migrations for MCP query performance.
--
-- Apply per-DB:
--   D2/R2 (OKK):       CREATE INDEX CONCURRENTLY idx_calls_mgr_created, idx_calls_created
--   D1 (Roleplay B2G): CREATE INDEX CONCURRENTLY idx_d1_calls_started
--   R1 (Roleplay B2B): CREATE INDEX CONCURRENTLY idx_r1_calls_started
--   Analytics:         CREATE INDEX CONCURRENTLY idx_lc_b2b_close (partial)
--
-- ⚠️  CRITICAL: CREATE INDEX CONCURRENTLY canNOT run inside a transaction
--     block. Neon's SQL editor wraps multi-statement submissions in an
--     implicit txn, which makes batch-paste FAIL with
--     "CREATE INDEX CONCURRENTLY cannot run inside a transaction block".
--
--     RUN EACH STATEMENT INDIVIDUALLY (one at a time, then submit).
--     Or use psql: `psql $DATABASE_URL -c "CREATE INDEX CONCURRENTLY ..."`
--     (psql is the only client that doesn't wrap in a txn for `-c`).
--
-- Source: database-architect Phase 2b review S2 + post-fix review.
-- =====================================================================

-- ─── D2 / R2 (apply on both OKK branches) ──────────────────────────────
-- scores_by_period & scores_by_manager filter calls by call_created_at and
-- (optionally) manager_id. Existing schema-okk.ts has only an index on
-- manager_id alone.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_calls_created
  ON public.calls (call_created_at)
  WHERE call_created_at IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_calls_mgr_created
  ON public.calls (manager_id, call_created_at)
  WHERE manager_id IS NOT NULL AND call_created_at IS NOT NULL;

-- ─── D1 / R1 (apply on both SM branches) ───────────────────────────────
-- analytics.scores_by_period for source=roleplay full-scans the calls table
-- on started_at. Schema declares no index there.

-- Apply on D1 branch:
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_d1_calls_started
  ON public.d1_calls (started_at);

-- Apply on R1 branch (same syntax — table is r1_calls):
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_r1_calls_started
  ON public.r1_calls (started_at);

-- ─── Analytics ─────────────────────────────────────────────────────────
-- daily.refusals for B2B groups by b2b_close_reason_enum_id with a created_at
-- range filter. Existing idx_lc_non_qual covers B2G; nothing for B2B.
-- Partial index keeps it small.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_lc_b2b_close
  ON analytics.leads_cohort (created_at)
  WHERE b2b_close_reason_enum_id IS NOT NULL;

-- ─── Smoke ─────────────────────────────────────────────────────────────
-- After each apply:
--   EXPLAIN (ANALYZE, BUFFERS) SELECT date_trunc('week', call_created_at AT TIME ZONE 'Europe/Berlin')::date,
--     COUNT(*) FROM public.calls
--     WHERE call_created_at >= '2026-04-01' AND call_created_at < '2026-05-01'
--     GROUP BY 1;
-- → should show "Index Scan using idx_calls_created" instead of "Seq Scan".
