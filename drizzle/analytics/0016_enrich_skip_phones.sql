-- 0016_enrich_skip_phones.sql
--
-- Skip-list for telephony phones that Kommo can't resolve to any lead.
--
-- Background: enrich-telephony-leads scans the oldest 200 unenriched
-- communications rows per tick (ORDER BY created_at ASC, LIMIT 200). When
-- the front of the queue is dominated by phones that don't exist in Kommo
-- as contacts (cold-dial numbers, mistyped digits, forwarded calls from
-- non-managers), every tick re-queries the same dead-letter set and never
-- makes progress on newer rows behind them. Observed 2026-05-11: 2261
-- unenriched rows across 271 distinct phones, with the same ~28 phones
-- blocking the queue for months.
--
-- Fix: a phone we've already tried and failed to resolve gets recorded
-- here. The enrich scan LEFT JOINs and filters them out, so the queue
-- moves to newer, resolvable phones. Periodic re-attempts are possible
-- via `last_attempted_at` if we ever want to retry (e.g., if the contact
-- finally gets imported into Kommo later — we'd clear or re-check the
-- row). Default behaviour is "skip forever" since these are calls to
-- numbers we've already determined don't belong to a Kommo lead.

CREATE TABLE IF NOT EXISTS analytics.enrich_skip_phones (
  phone               text PRIMARY KEY,
  first_skipped_at    timestamp NOT NULL DEFAULT now(),
  last_attempted_at   timestamp NOT NULL DEFAULT now(),
  attempts            integer   NOT NULL DEFAULT 1
);

COMMENT ON TABLE analytics.enrich_skip_phones IS
  'Phones the Kommo /contacts search returned 0 hits for. Excluded from enrich-telephony-leads scan so the dead-letter set doesn''t block the queue.';
