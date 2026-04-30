-- Payroll foundation — apply on the D1 (DATABASE_URL) database.
-- Idempotent: re-running this is a no-op once both objects exist.
--
-- 1. master_managers.daily_rate  — per-day base rate used by the payroll
--    calculator (currency is project-wide, not per-row). NULL = "not set yet";
--    the calculator treats NULL as zero gross.
-- 2. payroll_runs                — month-end snapshot per manager. The cron
--    upserts on (department, period_month, user_id) so re-runs overwrite.

ALTER TABLE master_managers
  ADD COLUMN IF NOT EXISTS daily_rate NUMERIC(12, 2);

CREATE TABLE IF NOT EXISTS payroll_runs (
  id                SERIAL PRIMARY KEY,
  department        TEXT NOT NULL,
  period_month      TEXT NOT NULL,
  user_id           UUID NOT NULL REFERENCES master_managers(id),
  manager_name      TEXT NOT NULL,
  daily_rate        NUMERIC(12, 2),
  status_breakdown  JSONB NOT NULL,
  equiv_full_days   NUMERIC(8, 2) NOT NULL,
  gross_amount      NUMERIC(14, 2) NOT NULL,
  computed_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS payroll_runs_uniq
  ON payroll_runs (department, period_month, user_id);

CREATE INDEX IF NOT EXISTS payroll_runs_period_idx
  ON payroll_runs (period_month);
