# TODO — actionable next steps

Read [SESSION-HANDOFF.md](./SESSION-HANDOFF.md) first for context.

Ordered by priority. Mark with `- [x]` when done; commit the change with the diff.

---

## P0 — Looker phone→lead enrichment (in progress 2026-04-28)

**Goal:** make Looker show real call counts (currently ~2% — 60 of 3105 calls in 4-day window). Root cause: 100% of telephony rows post-hard-split have `lead_id=NULL`, so `comm_agg ON ca.lead_id = fl.lead_id` excludes them. Verified live via Neon MCP.

**Architecture:** Pattern A (matches integrator MySQL semantics). Each CDR call → N rows in `analytics.communications`, one per lead the contact has, with `pipeline_id` per lead. `communication_id` (`cg-leg:N` / `ct:N`) collides intentionally across rows. Daily/Звонки use `COUNT(DISTINCT communication_id)` to keep one-call-counted-once semantics; Looker uses lead-level JOIN.

**Substeps (track each):**

- [x] Migration `0005_phone_enrichment.sql` (apply via Neon SQL editor — HTTP timed out on 0004):
  - Backup branch `pre-migration-0005-20260428` first.
  - `ALTER TABLE analytics.communications ADD COLUMN phone TEXT`.
  - `CREATE INDEX idx_comms_phone_unenriched ON analytics.communications(phone) WHERE lead_id IS NULL AND phone IS NOT NULL`.
  - DROP old `communications_communication_id_unique`, REPLACE with `(communication_id, COALESCE(lead_id, 0))` partial unique.

- [x] Update `schema-analytics.ts` — add `phone` field on `communications` table + replace uniqueIndex declaration to mirror new DDL.

- [x] `sync-telephony.ts` — write `phone` from `TelephonyCall.phone` into the new column. Drop old `.onConflictDoUpdate` (composite key with COALESCE expression isn't expressible in Drizzle target list — use DELETE-then-INSERT in window). DELETE wipes BOTH legacy non-prefix call rows AND cg-leg/ct prefix rows in the window so re-runs are clean.

- [x] `kommo/client.ts` — add `searchContactsByPhone(phones: string[]) → Map<phone, contactId[]>` and `getLeadsByIds(ids: number[]) → Map<leadId, {pipelineId,statusId,...}>`. Reuse existing rate limiter / pagination helpers.

- [x] `etl/enrich-telephony-leads.ts` — new file:
  - `SELECT DISTINCT phone FROM analytics.communications WHERE lead_id IS NULL AND phone IS NOT NULL AND communication_type LIKE 'call%' AND created_at IN [from, to]`.
  - Batch-resolve via Kommo `/api/v4/contacts?filter[query]=<phone>&with=leads`.
  - For each phone with N matched leads: UPDATE the first unenriched row with lead 1's metadata, INSERT N-1 additional rows for leads 2..N.
  - Pull lead metadata (pipeline_id, status_id, status_name, category, lead_created_at) from `analytics.leads_cohort` where possible — Kommo lookup only for phones not yet resolved.
  - Skip leads not in `leads_cohort` for our department's pipelines (foreign).
  - Return `{ phonesProcessed, leadsLinked, rowsInserted, unresolved: [phone] }` for logging.

- [x] `etl/index.ts` — wire `enrichTelephonyLeads` AFTER `syncTelephony` and BEFORE `computeSla` so SLA picks up enriched lead_ids. Make non-fatal on error.

- [x] `daily/analytics-calls.ts` — refactor every call-count aggregation:
  - `COUNT(*) FILTER (WHERE communication_type LIKE 'call%')` → `COUNT(DISTINCT communication_id) FILTER (WHERE …)`.
  - `SUM(duration) FILTER (…)` → wrap in CTE that DISTINCTs by communication_id first (same comm_id has same duration on every fanned-out row, so SUM-DISTINCT is a no-op per call but prevents N× inflation).
  - Files: `getAnalyticsCallMetricsByMaster`, `fetchTeamCallMetricsByPipeline`, `fetchTeamCallMetrics`, `getAnalyticsDailyTrend`, `getAnalyticsDailyTrendByLine`, `getAnalyticsDailyTrendByPipeline`.

- [x] `app/api/dashboard/route.ts` — re-enable B2B per-pipeline split:
  - Restore `getAnalyticsTeamCallMetricsByPipeline` + `getAnalyticsDailyTrendByPipeline` calls (replace `Promise.resolve(null)` blocks).
  - Re-import the helpers.
  - Bump `RESPONSE_CACHE_TTL` cache key from `v7` → `v8`.
  - Restore client-side rendering of `todayMetricsByPipeline` + `trendByPipeline`.

- [x] `app/api/analytics/looker/data/route.ts`:
  - Drop the "intentional gap" comment block in `commAggCte` (no longer applies after enrichment).
  - Add new view `cohorts_detail` — query: per-lead detail for one manager. Inputs: `manager` (required), `from`, `to`, `dept` already there. Returns: `lead_id, lead_created_at, current_status, sla_first_call_seconds, total_calls, success_calls, first_call_out_at, avg_gap_sec` ordered by `sla_first_call_seconds DESC NULLS LAST`. Add `cohorts_detail` to `VALID_VIEWS`.

- [x] `components/LookerTab.tsx` — SLA cohort drill-down feature:
  - Cohorts table rows become clickable.
  - Track `expandedManager: string | null` state.
  - On click: toggle expansion. When expanded, fetch `view=cohorts_detail&manager=<name>&from=&to=` and render an inline detail table BELOW the cohort table (or as an inline expanded `<tr>` with `colSpan`).
  - Detail table columns: Лид (с ссылкой `https://sternmeister.kommo.com/leads/detail/{id}` like TLT), Создан, SLA лид→звонок, Звонки (success/total), Первый звонок, Текущий статус. Sort by SLA desc.
  - Loading state, error state, empty state.

- [x] `scripts/enrich-telephony-leads.ts` — chunked CLI: `--from --to --chunk` (days). Wraps `enrichTelephonyLeads`. Logs per-chunk: phones processed, leads linked, unresolved count.

- [x] `scripts/recompute-sla.ts` — chunked CLI: `--from --to --chunk` (days). Wraps `computeSla` with date filter. Run after enrichment so SLA reflects new lead_ids.

- [ ] **Run full backfill** for 2026-01-01..2026-04-28 (sequence):
  1. `npx tsx scripts/backfill-from-telephony.ts --from 2026-01-01 --to 2026-04-28 --chunk 7` (rewrites raw rows now with `phone` column; ~15 min).
  2. `npx tsx scripts/enrich-telephony-leads.ts --from 2026-01-01 --to 2026-04-28 --chunk 7` (Kommo phone→lead resolution; ~25 min @ 7 req/s).
  3. `npx tsx scripts/recompute-sla.ts --from 2026-01-01 --to 2026-04-28 --chunk 7` (SLA pickup; ~2 min).

- [ ] **Post-backfill verification (audit anchor):**
  1. `GET /api/analytics/debug?dept=b2g&from=2026-04-25&to=2026-04-28` — `callsCounted` per day unchanged.
  2. Open Looker → All Calls → 2026-04-25..04-28 → totals should match Звонки/Daily within 5%. **Currently 60 vs 3105 (1.9%); target ~3000 vs 3105 (~95%).**
  3. Open Looker → Cohorts → check per-manager `SLA лид → звонок` — should be non-NULL for ~70-90% of managers (vs 2.6%/0% pre-fix).
  4. Click highest-SLA row → drill-down opens, shows ordered lead list with Kommo links. Click a lead, verify it opens correct deal.
  5. Open Dashboard → Звонки → switch to B2B → verify Бух Комм / Мед Комм tile + trend split shows real numbers (not zeros).
  6. Compare Daily/Звонки call totals before/after — should be ~unchanged (DISTINCT comm_id keeps semantics).
  7. Check cron logs at next 15-min tick — `[ETL] enrich-telephony-leads: processed N phones, linked M leads` log should appear.

- [ ] Provision Dokploy etl-cron sidecar with `KOMMO_ACCESS_TOKEN` (already there) + new behaviour just kicks in. No new env needed.

- [ ] Update `docs/SESSION-HANDOFF.md` — mark "Known limitations #1" partially resolved (CDR coverage still depends on telephony tokens being live; phone→lead enrichment now closes the lead-attribution gap).

- [ ] Update `docs/DASHBOARD-ZVONKI.md` — remove "Why B2B has no per-pipeline split" section; update KPI tiles description to note `COUNT(DISTINCT communication_id)` semantics.

---

## P0 — call accuracy (blocking user-facing issue)

- [ ] **Confirm local backfill finished cleanly.**
  - `tail -f /tmp/backfill.log` until `=== DONE ===`. Note `Failures: N`. If N>0, list the bad chunks.
  - Re-run failed chunks: `npx tsx scripts/backfill-by-day.ts --from <from> --to <to> --chunk 1`
  - Verify via `GET /api/analytics/debug?dept=b2g&from=2026-04-25&to=2026-04-28` — `callsCounted` should be reasonable for each working day.

- [ ] **Compare Kommo /notes counts vs Looker.** Run both:
  - `GET /api/analytics/debug-kommo?from=2026-04-21T00:00:00Z&to=2026-04-28T00:00:00Z` → `total` is what Kommo gave us
  - Open Looker tab → All Calls → same window → compare totals
  - If delta < 5%: Kommo /notes is sufficient, mark P1 done-by-acceptance.
  - If delta > 5%: P1 telephony CDR is needed.

- [ ] **Verify dashboard "Звонки" matches reality.** Open today, eyeball per-manager numbers against PBX panel.

---

## P1 — direct telephony CDR integration (core feature gap)

**CallGear + CloudTalk: DONE 2026-04-28.** End-to-end: clients + ETL writer + backfill script + cron wired. Smoke test 2026-04-27: 1070 cg legs + 1089 ct calls = 2159 rows in 31s wall time.

- [x] Inspect `/Users/user/okk/.env` — found `CALLGEAR_ACCESS_TOKEN`. CloudTalk creds provided by user separately.
- [x] Read OKK webhook handlers (`/Users/user/okk/src/webhook/{callgear,cloudtalk}.ts`) — payload shapes captured in code comments of new clients.
- [x] `src/lib/telephony/callgear.ts` — JSON-RPC 2.0 client. Joins `get.calls_report` (session direction) with `get.call_legs_report` (per-employee leg). Filters to `is_operator=true && !is_coach`. Pagination + 5xx backoff.
- [x] `src/lib/telephony/cloudtalk.ts` — Basic-auth client. `/api/calls/index.json` paginated by date_from/date_to. Skips queue-only rings (no agent attribution).
- [x] `src/lib/etl/sync-telephony.ts` — fetches both providers in parallel, attributes by `callgear_employee_id` / `cloudtalk_agent_id`, writes to `analytics.communications`. pipeline_id NULL; call_status=4 for answered. Idempotent via prefix-scoped DELETE-by-date.
- [x] `scripts/backfill-from-telephony.ts` — chunked CLI backfill (both providers). Lists unmatched agent IDs at end.
- [x] Wired into `runSync` — auto-runs when `CALLGEAR_ACCESS_TOKEN` OR `CLOUDTALK_API_ID` is set; per-provider failure non-fatal.

- [x] **Run wider telephony backfill** — DONE 2026-04-28 in 14m51s. Result: 106516 cg + 22557 ct = 129073 rows for 2026-01-01..04-28. 0 kommo orphan rows after cleanup pass.

- [ ] **Provision telephony tokens in Dokploy** etl-cron sidecar:
  - `CALLGEAR_ACCESS_TOKEN` (matches `/Users/user/okk/.env`)
  - `CLOUDTALK_API_ID`
  - `CLOUDTALK_API_SECRET`

- [x] **Link unmatched managers** — `scripts/link-managers-telephony.ts` resolves `callgear_employee_id` + `cloudtalk_agent_id` by name and writes to master_managers + OKK. 7 rows linked on 2026-04-28 first run.
  Still without telephony accounts (no API match — all known ROPs/inactives): Рузанна, Дмитрий, Юлия Смирнова, Екатерина Маслий (ct only), Кристина Аладко (ct only). Fine; their calls won't surface on dashboard.
- [x] **Auto-resolve cg + ct on manager save** — added Step 3.6 in `/api/managers/route.ts`. Save now hits CallGear `get.employees` + CloudTalk `/agents/index.json`, name-matches with same alias table as Kommo, fills NULL fields.
- [x] **Hard-split DONE.** `sync-communications.ts` no longer pulls call notes. Telephony is sole source for calls. Dashboard double-counting eliminated.

  Old `note:N` call rows that landed before this change get wiped by the next overlapping Kommo backfill (the prefix-scoped DELETE catches them). PID 12795 is currently doing this for Jan-Apr 2026.

- [ ] **Bump `CURRENT_FILTER_VERSION` to 9** in `src/lib/tracking/sync.ts` if tracking timeline should also start using telephony as the primary call source.

- [ ] **Phone → lead enrichment in `sync-telephony.ts`.** Every CDR row currently lands with `pipeline_id=NULL` because PBX writes the call before any Kommo lead exists. Verified 2026-04-28: 100% of cg-leg + ct rows have NULL pipeline_id (11,186 rows / last 7d). This blocks:
  1. **B2B per-pipeline tile/trend split** (Бух Комм / Мед Комм) — currently disabled in `/api/dashboard/route.ts`, see comment `v7 cache-key`.
  2. **`avg-calls-per-lead` widget** — returns null post-split.
  3. **Looker cohort views aggregating calls per lead** — telephony rows are correctly excluded but numbers diverge from Daily/Звонки (intentional, but fixable).

  **Implementation sketch:**
  - At write time in `src/lib/etl/sync-telephony.ts`, batch-resolve phones via Kommo `/api/v4/leads?filter[query]=<phone>` (or analytics.leads_cohort if phone column added).
  - Add `phone` column to `analytics.communications` first (migration). Currently sync writes the phone but doesn't persist it.
  - Or alternative: add `phone` column to `analytics.leads_cohort`, then JOIN at query time without an enrichment pass — simpler but slower.
  - Verified rejection: manager → primary-pipeline heuristic. Top B2B managers split 60/40 across BK/MK (Rose 149/123, Метальникова 178/7, Пуховская 122/53). ~40% attribution error.

  **Once landed:** uncomment the two parallel fetches in `/api/dashboard/route.ts` (`getAnalyticsTeamCallMetricsByPipeline` + `getAnalyticsDailyTrendByPipeline`) — helpers stay exported in `src/lib/daily/analytics-calls.ts`. Also unblocks proper per-pipeline B2B trend chart dropdown.

---

## P2 — data integrity hardening

- [ ] **Apply the unique-index migration** (`drizzle/analytics/0004_communications_unique.sql`) via Neon SQL editor (NOT the serverless HTTP driver — it timed out on dedup).
  - First run the dedup with `USING` self-join: `DELETE FROM analytics.communications a USING analytics.communications b WHERE a.communication_id IS NOT NULL AND a.communication_id = b.communication_id AND a.ctid > b.ctid`
  - Then create the partial unique index.
  - After applied, switch `sync-communications.ts` Phase 5 from `DELETE+INSERT` back to `ON CONFLICT (communication_id) DO UPDATE` (was reverted in commit `6c36519` because Neon HTTP timed out).

- [ ] **Verify ETL cron fires correctly.** In Dokploy, check the etl-cron sidecar is running. `[ETL cron] incremental sync window: ...` should appear every 15 min in app logs.

- [ ] **Add Sentry alerts for ETL failures.** Currently failures only show in logs. A persistent alert if `sync-communications failed: ...` appears 3 times in a row would catch silent breakages faster.

---

## P3 — nice-to-haves

- [ ] **Persistent tracking blacklist.** Add `tracking_invalid_event_types` table in TRACKING_DATABASE_URL DB. Persist `INVALID_BY_ENTITY` Map on add. Load on `ensureTrackingSchema()`. Saves ~5 requests per bad type after restart. Low impact.

- [ ] **Distributed sync lock.** If/when scaling to 2+ Dokploy replicas, add `pg_try_advisory_lock(hashtext('tracking-sync-' || dept))` at start of `syncDepartment`. Currently single-replica, so no race.

- [ ] **Replace `getMessageEvents` lead-only filter** with proper canonical-lead resolution like `syncCommunications` does for calls. Currently messages on contacts (without a linked lead at message time) are dropped. Probably <2% of messages — low priority.

- [ ] **Cleanup unused functions in `src/lib/kommo/client.ts`:** `getAccount`, `getCallNotes`, `getCallEvents` (deprecated), `getCallNoteParams`. They have zero callers but clutter the module.

- [ ] **Update `CLAUDE.md` Architecture section** with the analytics.* schema once telephony integration lands. The current description is from before the analytics-mirror refactor.

---

## P4 — explorations (do only if user asks)

- [ ] Mirror from MySQL integrator at `45.156.25.84:3306` directly. Full schema is in `docs/mysql-analytics.md`. Pros: 100% parity with their Looker. Cons: requires creds, depends on their daily Airflow refresh cadence, doesn't fix real-time gap.

- [ ] Switch tracking sync to use OKK's `okkCalls` table (`D2_OKK_DATABASE_URL` / `R2_OKK_DATABASE_URL`) for connected calls + telephony CDR for missed/short. Today, `okkCalls` only has connected ≥10s calls (verified — see the check we ran).

---

## DONE recently (for grep'ability when reviewing what changed)

- [x] **Termin dashboard tab** — new admin-only section showing cohort line chart of avg days from deal creation → assigned «Дата термина» / «Дата термина АА» for Бух Бератер pipeline. (2026-04-28)
  - Migration `drizzle/analytics/0006_termin_dates.sql` — adds `termin_date` + `aa_termin_date` columns + partial index `idx_lc_termin_cohort` on `leads_cohort`. Applied via Neon MCP.
  - Custom-field name resolution in `B2G_CUSTOM_FIELD_NAMES` (`pipeline-config.ts`): "Дата термина ДЦ" / "Дата термина" (fallback) / "Дата термина АА". Looked up by NAME — Kommo IDs differ across leads (verified live: 885996 generic vs 887026 specific).
  - ETL: `sync-leads.ts` extracts both fields via existing `findByName` + `parseDate` path (same as B2B payment fields). 15-min cron auto-picks-up via `incremental` mode.
  - API: `GET /api/dashboard/termins?dateFrom&dateTo` — single-SQL CTE join `leads_cohort` × `lead_status_changes`. AA baseline switches to `MIN(event_at) WHERE status_id = TERM_DC_DONE` (93886075) when present, falls back to `created_at` otherwise. Excludes negatives + NULL terminы. Round to 1 decimal.
  - UI: `TerminTab.tsx` — Recharts LineChart, period chips (Сегодня/7д/30д/Месяц/Произвольный) + CalendarPicker, summary tiles, custom tooltip (date / DC / AA / count), mobile-responsive, `connectNulls`.
  - Backfill: `scripts/backfill-termins.ts` runs only `syncLeads + syncStatusChanges` chunked, ~30s/7d. Resumable on chunk failure.
  - Doc: `docs/DASHBOARD-TERMIN.md`.

- [x] **Звонки tab refactor** — full per-section rework. (2026-04-28, commits cbd6355 → 6737362)
  - 4 KPI tiles compact, 1-row responsive (`grid-cols-2 sm:grid-cols-4`), with full funnel labels («Квалификация / Бератер / Доведение» for B2G).
  - Removed obsolete tiles: «Просрочено задач», «Выручка», «Менеджеров», «Воронка лидов».
  - Per-manager call tables moved up directly after KPI tiles (detail bound to top filter).
  - Trend chart with line dropdown for B2G (server: `getAnalyticsDailyTrendByLine`).
  - Cohort status table — replaces old per-pipeline cards with single filterable table.
    Filters: 2 funnel checkboxes (Квалификатор/Бератер for B2G; Бух Комм/Мед Комм for B2B) + status multi-select dropdown with «Выбрать все / Снять все».
    Cohort = leads created in [from, to] across all statuses (active + closed = lifecycle).
    Percent base = sum of currently shown rows.
  - Live status names from Kommo `/leads/pipelines` keyed by `pipelineId:statusId` — kills "Status 12345" and the 142/143 collision (Won/Lost are global IDs with per-pipeline labels).
  - Bug fix: `data` in `fetchData` useCallback deps caused infinite refetch loop on every setData. Replaced with `hasDataRef`. This was the source of "data doesn't refresh on date change" report.
  - B2B per-pipeline tile/trend split *intentionally disabled* — see new P1 phone→lead enrichment task. Cohort table still splits per-pipeline because LEADS have pipeline_id (calls don't).
  - Migration `0004_communications_unique.sql` applied via Neon MCP — 3,913 dupes deleted, partial unique index created. `sync-communications.ts` + `sync-telephony.ts` Phase-5 flipped to `ON CONFLICT DO UPDATE` (commit 8e4be3d).
  - `docker-compose.yml` whitelist: added `CALLGEAR_ACCESS_TOKEN` + `CLOUDTALK_API_ID` + `CLOUDTALK_API_SECRET` (was the actual blocker for prod telephony — env was in Dokploy UI but not piped into the container).
- [x] Wider telephony backfill — 4 months, 129k rows (cg 106516 + ct 22557), 0 kommo orphans, 14m51s wall time. (2026-04-28)
- [x] syncTelephony DELETE extended to wipe stale pre-split `note:N` call rows in same window — auto-cleanup on every backfill. (2026-04-28)
- [x] avg-calls-per-lead widget marked as known regression post-split (returns null) — needs phone→lead enrichment to work properly. (2026-04-28)
- [x] `maxDuration=30` cap on /api/managers route — prevents 504s under provider rate-limit storms. (2026-04-28)
- [x] Hard-split: `sync-communications.ts` drops call-note fetch, telephony owns calls. (2026-04-28)
- [x] Auto-resolve CG/CT IDs in `/api/managers` POST + GET. `scripts/link-managers-telephony.ts` for one-shot backfill. 7 managers linked on first run. (2026-04-28)
- [x] CloudTalk telephony integration — `src/lib/telephony/cloudtalk.ts` + extended `sync-telephony.ts` to fan out to both providers in parallel. Smoke 2026-04-27: 1089 ct calls + 1070 cg legs = 2159 rows. (2026-04-28)
- [x] CallGear telephony CDR integration — `src/lib/telephony/{types,callgear}.ts` + `src/lib/etl/sync-telephony.ts` + `scripts/backfill-from-telephony.ts` + wired into `runSync`. (2026-04-28)
- [x] `filter[updated_at]` fix in `getAllCallNotesByDate` — `f4bd662` (the big one)
- [x] Per-entity loop + per-entity blacklist in `fetchRawEvents` — `64e99d9`, `2dcbd48`, `6c36519`
- [x] Drop `customer` from `KOMMO_ENTITIES` (Kommo /events rejects it) — `2dcbd48`
- [x] Tracking timeline 09:00–20:00 Berlin time — `2fe3b13`
- [x] Manager attribution fallback to `responsibleUserId` — `2fe3b13`
- [x] Tracking sync calls via /notes (was /events with filter[created_by] gap) — `2fe3b13`
- [x] `/api/analytics/debug` per-day breakdown endpoint — `eb982e1`
- [x] `/api/analytics/debug-kommo` direct Kommo passthrough — `4eecbc2`
- [x] `/api/analytics/backfill` streaming chunked endpoint — `d4be739`
- [x] `getTasks` server-side filter by `responsible_user_id` — `a71d87b`
- [x] Local script `scripts/backfill-by-day.ts` — created today
- [x] User permission to read `/Users/user/okk` for next session — added to `~/.claude/settings.json`
