-- 0009_integrator_snapshot.sql
--
-- One-time snapshot of integrator-computed SLA/TLT values for the
-- 7000+ leads they had processed before we cut off their feed.
-- Looker COALESCE'es these into our queries — for historical leads
-- shows integrator-exact numbers, for new leads (where integrator
-- columns are NULL) falls back to our compute-sla output.
--
-- The columns are write-once: our incremental ETL (compute-sla.ts)
-- doesn't touch them. Backfill is a separate one-shot script
-- (scripts/backfill-integrator-sla.ts) that uses temporary MySQL
-- access — once integrator is decommissioned, these columns stay
-- frozen at the snapshot values.
--
-- Apply via Neon SQL editor.

ALTER TABLE analytics.sla
  ADD COLUMN IF NOT EXISTS sla_first_call_seconds_integrator         BIGINT,
  ADD COLUMN IF NOT EXISTS sla_first_call_calendar_seconds_integrator BIGINT,
  ADD COLUMN IF NOT EXISTS tlt_integrator                             BIGINT;
