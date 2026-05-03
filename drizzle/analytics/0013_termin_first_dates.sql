-- B1: write-once "first observed" copies of termin_date / aa_termin_date.
-- The plain termin_date column overwrites on every Kommo reschedule, so the
-- original commitment is lost. ETL preserves these via pre-fetch on resync
-- (see sync-leads.ts). Backfilled to current value for legacy leads.

ALTER TABLE analytics.leads_cohort
  ADD COLUMN IF NOT EXISTS termin_date_first    timestamp,
  ADD COLUMN IF NOT EXISTS aa_termin_date_first timestamp;

-- Legacy backfill: no real history available, so seed with current value.
-- Future syncs preserve whatever's already here.
UPDATE analytics.leads_cohort
   SET termin_date_first = termin_date
 WHERE termin_date_first IS NULL AND termin_date IS NOT NULL;

UPDATE analytics.leads_cohort
   SET aa_termin_date_first = aa_termin_date
 WHERE aa_termin_date_first IS NULL AND aa_termin_date IS NOT NULL;
