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

**Pre-requisite:** restart Claude Code so updated `~/.claude/settings.json` permissions kick in (we added `Read(/Users/user/okk/**)` and `additionalDirectories: ["/Users/user/okk"]` so /Users/user/okk is readable).

- [ ] **Inspect `/Users/user/okk/.env`** — find creds:
  - CallGear: API token + base URL + account ID
  - CloudTalk: API key ID + secret + base URL
  - If anything is missing, ask user to share or check OKK service config

- [ ] **Read OKK's webhook handler** (`/Users/user/okk/src/webhook/*.ts` or similar) to understand:
  - Which fields in the webhook payload identify a manager
  - What the call-status enum values mean
  - Whether OKK already filters out short calls before storing

- [ ] **Write `src/lib/telephony/callgear.ts`**:
  - `getCallsByDate(from: Date, to: Date): Promise<TelephonyCall[]>`
  - Pagination, rate-limit handling, retry on 5xx
  - Return unified shape:
    ```ts
    type TelephonyCall = {
      source: "callgear" | "cloudtalk";
      externalId: string;          // call ID from telephony
      type: "incoming" | "outgoing";
      agentId: string | null;      // matches master_managers.callgearEmployeeId
      phone: string;
      startedAt: Date;
      durationSec: number;
      status: "answered" | "missed" | "busy" | "failed" | "no_answer";
      recordingUrl: string | null;
    };
    ```

- [ ] **Write `src/lib/telephony/cloudtalk.ts`** — same shape.
  - Note: user mentioned CloudTalk currently only has POST webhook. If their account doesn't have read API:
    - **Option A:** ask them to enable API access (Settings → Account → API)
    - **Option B:** extend OKK's webhook receiver to forward ALL raw call events (not just those passing OKK's pipeline filter)

- [ ] **Write `scripts/backfill-from-telephony.ts`** — pull from both APIs, map `agentId` → `master_managers.id` via `master_managers.callgearEmployeeId` / `cloudtalkAgentId`, write to `analytics.communications`.

- [ ] **Decide architecture: replace or merge with Kommo /notes?**
  - My take: telephony is source-of-truth for CALLS. Kommo /notes is source-of-truth for chat messages, emails, SMS. Split cleanly:
    - ETL `syncCommunications` — only chat/email/SMS from Kommo `getMessageEvents`
    - New `syncTelephonyCalls` — calls from CallGear + CloudTalk
    - `analytics.communications.communication_id` distinguishes by prefix: `note:N` for Kommo, `cg:N` for CallGear, `ct:N` for CloudTalk

- [ ] **Wire into `runSync`** in `src/lib/etl/index.ts` so the cron picks it up.

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
