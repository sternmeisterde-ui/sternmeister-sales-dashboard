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

-- 3. payroll_runs.bonus_amount — manual premium amount included in the
--    snapshot's gross. Default 0 so existing rows stay coherent.
ALTER TABLE payroll_runs
  ADD COLUMN IF NOT EXISTS bonus_amount NUMERIC(12, 2) NOT NULL DEFAULT 0;

-- 4. manager_bonuses — live state for monthly premiums. The Табель popup
--    upserts here (one row per user × month). amount = 0 / NULL is stored
--    as "no row" — clearing simply deletes the row.
CREATE TABLE IF NOT EXISTS manager_bonuses (
  id           SERIAL PRIMARY KEY,
  user_id      UUID NOT NULL REFERENCES master_managers(id),
  period_month TEXT NOT NULL,
  amount       NUMERIC(12, 2) NOT NULL,
  note         TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS manager_bonuses_uniq
  ON manager_bonuses (user_id, period_month);
