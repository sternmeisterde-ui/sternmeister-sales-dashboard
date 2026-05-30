-- 0017_contacts.sql
--
-- Contacts mirror for Funnel Dashboard and any feature that needs client
-- names/phones. Until now leads_cohort carried only deal metadata; client
-- name and phone(s) live on Kommo Contact, never copied here.
--
-- Sourced via /api/v4/contacts?filter[id][]=... in batches of 250 from the
-- contact_ids carried in lead._embedded.contacts (already returned by
-- sync-leads' getLeads call with `with=contacts`). One extra Kommo request
-- per ~250 contacts; full 6-month backfill is ~24 requests at 1 rps.
--
-- ETL: src/lib/etl/sync-contacts.ts runs right after sync-leads in the main
-- pipeline. Idempotent: ON CONFLICT DO UPDATE for both tables. Backfill
-- can be restarted from any --from boundary without dedup work.
--
-- Apply via Neon SQL editor (Drizzle's HTTP driver has timed out on ALTER
-- TABLE before — see migrations 0004/0005 history).

CREATE TABLE IF NOT EXISTS analytics.contacts (
  contact_id          BIGINT PRIMARY KEY,
  name                TEXT,
  first_name          TEXT,
  last_name           TEXT,
  phone               TEXT,                       -- primary phone (first one)
  phones_all          JSONB,                      -- all phones, de-duplicated
  responsible_user_id BIGINT,
  kommo_created_at    TIMESTAMP,
  kommo_updated_at    TIMESTAMP,
  raw_payload         JSONB NOT NULL,             -- full Kommo snapshot for debug
  synced_at           TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_contacts_phone
  ON analytics.contacts (phone);

CREATE INDEX IF NOT EXISTS idx_contacts_updated_at
  ON analytics.contacts (kommo_updated_at);

-- Many-to-many: one lead can have multiple contacts (rare), one contact can
-- belong to multiple leads (common — same client across Бух Гос and Бух
-- Бератер). is_active stays TRUE while the link is in Kommo's current
-- snapshot; flipped to FALSE if Kommo no longer returns it (e.g. manager
-- detached the contact). Rows are never deleted so history is preserved.
CREATE TABLE IF NOT EXISTS analytics.lead_contact_links (
  lead_id        BIGINT NOT NULL,
  contact_id     BIGINT NOT NULL,
  first_seen_at  TIMESTAMP NOT NULL DEFAULT NOW(),
  last_seen_at   TIMESTAMP NOT NULL DEFAULT NOW(),
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  PRIMARY KEY (lead_id, contact_id)
);

CREATE INDEX IF NOT EXISTS idx_lcl_contact_id
  ON analytics.lead_contact_links (contact_id);

CREATE INDEX IF NOT EXISTS idx_lcl_active
  ON analytics.lead_contact_links (lead_id)
  WHERE is_active = TRUE;
