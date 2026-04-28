# TODO — actionable next steps

Read [SESSION-HANDOFF.md](./SESSION-HANDOFF.md) first for context.

Ordered by priority. Mark with `- [x]` when done; commit the change with the diff.

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
