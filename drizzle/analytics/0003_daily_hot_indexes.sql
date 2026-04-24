-- 0003_daily_hot_indexes.sql
-- Phase 1 of the Daily refactor (2026-04-24). The analytics mirror was
-- migrated to Neon without the btree indexes that the Daily tab hot-path
-- needs — every /api/daily request was doing full sequential scans on
-- leads_cohort / sla / communications / tasks, which melted Neon under
-- weekly/monthly range loads.
--
-- All indexes are CONCURRENTLY so they don't block writers. Drizzle does
-- not emit CONCURRENTLY, so this migration is hand-rolled and applied
-- directly via psql / Neon MCP. The matching `index()` declarations in
-- src/lib/db/schema-analytics.ts are kept up to date so future `drizzle
-- generate` won't try to re-create them.

-- ------------------------------------------------------------------
-- leads_cohort — covers funnel snapshots, won/lost by closed_at,
-- new leads by created_at, per-manager rollups, non-qual exclusion.
-- ------------------------------------------------------------------
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_lc_pipeline_closed
  ON analytics.leads_cohort (pipeline_id, closed_at);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_lc_pipeline_created
  ON analytics.leads_cohort (pipeline_id, created_at);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_lc_pipeline_status
  ON analytics.leads_cohort (pipeline_id, status_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_lc_responsible
  ON analytics.leads_cohort (responsible_user_id)
  WHERE responsible_user_id IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_lc_non_qual
  ON analytics.leads_cohort (non_qual_enum_id)
  WHERE non_qual_enum_id IS NOT NULL;

-- ------------------------------------------------------------------
-- sla — getSlaFacts filters by (pipeline_id, lead_created_at),
-- getFrozenLeadsTeam by (sla_status, lead_created_at).
-- ------------------------------------------------------------------
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sla_pipeline_leadcreated
  ON analytics.sla (pipeline_id, lead_created_at);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sla_status_leadcreated
  ON analytics.sla (sla_status, lead_created_at);

-- ------------------------------------------------------------------
-- communications — getAnalyticsCallMetricsByMaster groups by
-- (manager, pipeline_id, created_at); dashboard/daily filters by
-- (pipeline_id, created_at).
-- ------------------------------------------------------------------
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_comm_pipeline_created
  ON analytics.communications (pipeline_id, created_at);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_comm_manager_pipeline_created
  ON analytics.communications (manager, pipeline_id, created_at);

-- ------------------------------------------------------------------
-- tasks — getOverdueTasksByManager filters by
-- (task_manager, is_completed, deadline). tasks has no pipeline_id.
-- ------------------------------------------------------------------
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tasks_mgr_completed_deadline
  ON analytics.tasks (task_manager, is_completed, deadline);
