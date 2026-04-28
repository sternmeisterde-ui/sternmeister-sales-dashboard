-- 0005_phone_enrichment.sql
--
-- Phone→lead enrichment for telephony rows. Pattern A (matches integrator
-- MySQL semantics from docs/mysql-analytics.md): each CDR call → N rows in
-- analytics.communications, one per lead the contact has, sharing the same
-- communication_id. Daily/Звонки aggregations switch to
-- COUNT(DISTINCT communication_id) so a single call still counts once.
-- Looker per-lead aggregations stay correct because they JOIN on lead_id.
--
-- Applied 2026-04-28 via Neon MCP (HTTP serverless driver) — backup branch
-- pre-migration-0005-20260428 (br-curly-river-andpk4mr) created first.
--
-- Verified post-apply:
--   has_phone_col=1, has_composite_uniq=1, has_phone_idx=1, old_uniq=0.

-- 1. Phone column on communications. Filled at write time by sync-telephony
--    (from TelephonyCall.phone) and used by enrich-telephony-leads to
--    resolve phone → contacts → leads via Kommo /api/v4/contacts.
ALTER TABLE analytics.communications ADD COLUMN IF NOT EXISTS phone TEXT;

-- 2. Drop the single-column partial unique that was added in 0004.
--    Pattern A allows multiple rows per communication_id (one per matched
--    lead), so the unique key needs to include lead_id.
DROP INDEX IF EXISTS analytics.communications_communication_id_unique;

-- 3. Composite partial unique on (communication_id, COALESCE(lead_id, 0)).
--    COALESCE collapses NULL lead_id to 0 inside the index expression so the
--    "raw, not-yet-enriched" row also participates in uniqueness — only one
--    raw row per communication_id is allowed; subsequent fan-out copies must
--    have a real lead_id. Partial WHERE clause keeps legacy/orphan rows
--    without a comm_id from blocking the constraint.
CREATE UNIQUE INDEX IF NOT EXISTS communications_comm_lead_unique
  ON analytics.communications (communication_id, COALESCE(lead_id, 0))
  WHERE communication_id IS NOT NULL;

-- 4. Helper index for the enrichment scan: select rows still needing
--    phone→lead resolution. Partial keeps it tiny — only un-enriched rows
--    appear, so the index size stays small even on the 130k-row mirror.
CREATE INDEX IF NOT EXISTS idx_comms_phone_unenriched
  ON analytics.communications (phone)
  WHERE lead_id IS NULL AND phone IS NOT NULL;
