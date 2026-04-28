-- Add UNIQUE on analytics.communications.communication_id so the ETL
-- can reliably upsert by note id.
--
-- Without this, the incremental cron's DELETE-by-created_at pattern leaks
-- duplicates whenever a note is edited after creation: the cron at edit
-- time fetches the note (via filter[updated_at]), inserts a row with the
-- ORIGINAL created_at — but DELETE only covers the cron's last-15-min
-- window keyed by created_at, so the older row stays and we get two rows
-- for the same physical note. COUNT(*) in dashboard SQL overcounts.
--
-- Step 1: dedupe existing rows. Keep the row with the smallest ctid for
-- each communication_id (arbitrary but stable — they're identical except
-- for ctid). NULL communication_id rows are left alone (legacy/orphan).
DELETE FROM analytics.communications a
WHERE a.communication_id IS NOT NULL
  AND a.ctid NOT IN (
    SELECT MIN(b.ctid)
    FROM analytics.communications b
    WHERE b.communication_id = a.communication_id
    GROUP BY b.communication_id
  );

-- Step 2: enforce uniqueness going forward. Partial index excludes NULL so
-- legacy orphan rows (communication_id IS NULL) don't conflict with each
-- other. Future ETL runs can use ON CONFLICT (communication_id) DO UPDATE.
CREATE UNIQUE INDEX IF NOT EXISTS communications_communication_id_unique
  ON analytics.communications (communication_id)
  WHERE communication_id IS NOT NULL;
