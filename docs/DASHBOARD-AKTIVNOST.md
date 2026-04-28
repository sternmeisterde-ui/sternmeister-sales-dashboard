# Dashboard — Активность tab

Last updated: 2026-04-28

Per-manager activity timeline showing time on calls (blue), CRM work
(green), and idle (grey) within a fixed 09:00–20:00 Berlin window.
Source of truth: `tracking_events` in the dedicated tracking Neon
project (`TRACKING_DATABASE_URL`).

---

## What's tracked

41 event types — every type that has fired at least once on
sternmeister.kommo.com between 2026-01-01 and 2026-04-28. The list is
maintained in `src/lib/tracking/event-types.ts`. Anything not in there
is either an unused Kommo feature on this account or a structural API
limit — the file's header explains how to restore an entry if a
feature gets enabled later.

| Group | Types |
|---|---|
| Звонки | incoming_call, outgoing_call |
| Сделки | lead_added/deleted/restored/status_changed/linked/unlinked |
| Контакты | contact_added/deleted/restored/linked/unlinked |
| Компании | company_added/linked/unlinked |
| Задачи | task_added/completed/deleted/type_changed/deadline_changed/text_changed/result_added |
| Коммуникации | outgoing_chat_message, entity_direct_message, incoming_mail, outgoing_mail |
| Теги и связи | entity_tag_added/deleted, entity_linked, entity_unlinked |
| Изменения полей | entity_responsible_changed, sale_field_changed, name_field_changed, custom_field_value_changed (collapses 200+ per-id variants) |
| Примечания | common_note_added/deleted, attachment_note_added |
| Беседы | talk_closed, conversation_answered |
| Прочее | entity_merged |

**Not tracked, by reason:**

| Reason | Types |
|---|---|
| Kommo `/events` filter[entity]=customer rejected | customer_added/deleted/status_changed/linked/unlinked |
| Kommo asymmetric on this account (only outgoing returned) | incoming_chat_message, incoming_sms, outgoing_sms |
| Account doesn't use the feature (would fire if enabled) | ai_result, robot_replied, key_action_completed, intent_identified, segment_*, targeting_*, transaction/invoice_*, nps_rate_added, message_to_cashier_note_added, meta_chat_subscription_*, zoom_conference, dropbox_attachment, picture/video_*, link_followed/site_visit/page_mention, ltv_field_changed, geo/service_note_added, talk_created, talk_missed_event, company_deleted/restored |

---

## How call data flows (different from CRM events)

Kommo's `/api/v4/events` endpoint requires `filter[created_by]` for
manager scoping, which silently drops calls written by PBX service
users (CallGear / CloudTalk integrations). So calls go through a
different path:

```
/contacts/notes  ┐
/leads/notes     ├──► getAllCallNotesByDate()  ──► dedup by note.id
/companies/notes ┘                                       │
                                                          ▼
                          attribute(createdBy, responsibleUserId)
                                          │
                                          ▼
                          tracking_events (eventId="note:<id>")
```

- Filter: `filter[note_type] IN (call_in, call_out)` + `filter[updated_at][from/to]`
- `created_at` is preserved as the event timestamp (the call's actual time).
- `params.duration` → `duration_sec`. Missed calls = `duration_sec=0`,
  stored in cache but not rendered on the bar (timeline.ts:175).
- `params.{uniq, source, link, phone, call_status, call_result}` go
  into `raw` JSONB. `uniq` is the PBX call ID — cross-references
  `analytics.communications.uniq` for sanity checks.

---

## Manager attribution

`sync.ts:216-224` `attribute(createdBy, responsibleUserId)`:

1. `note.created_by` matched against `master_managers.kommo_user_id`?
   → matched
2. Else `note.responsible_user_id` matched? → matched
   (PBX service-user fallback path)
3. Else → DROP (call is not by any current manager — never lands)

Manager pool comes from `getManagersForDept` (sync.ts):

```sql
WHERE department = :dept
  AND is_active = true
  AND (role = 'manager' OR (role = 'rop' AND line IS NOT NULL))
  AND kommo_user_id IS NOT NULL
```

The double-status carve-out (rop+line) brings in Татьяна Дерикова
(b2g, line=2). Plain ROPs without a line (Дмитрий, Рузанна) coordinate
without dialling and stay excluded.

Юлия Смирнова (b2b) is `kommo_user_id=NULL` because she works only in
ролевки without Kommo CRM access — see
`memory/project_yulia_smirnova_roleplay_only.md`.

---

## Timeline math

`src/lib/tracking/timeline.ts` builds a per-minute classification
within 09:00–20:00 Berlin (660 minutes). Each minute is exactly one
of: call (blue), crm (green), idle (grey).

**Call minutes (blue):**
- Rendered as a contiguous block from `event.created_at` for
  `max(1, round(durationSec/60))` minutes — short calls get a 1-min
  visual floor for visibility.
- Side-panel `pct.call` and `minutes.call` ignore the visual floor
  and use `callSecExact = sum of clipped seconds` to avoid
  over-counting a barrage of <60s calls. A call running 19:55→20:30
  contributes 5 minutes (clipped at shift end).

**CRM minutes (green):**
- Each event = 1 minute mark. Multiple events in the same minute
  collapse to one mark (no over-count).
- Adjacent green minutes within `CRM_CLUSTER_GAP_MIN=2` are merged
  into a single readable stripe.
- Per-id `custom_field_<ID>_value_changed` events normalize to the
  generic key via `normalizeEventType()` so one filter checkbox
  covers all field changes.
- `entity_linked` / `entity_unlinked` carry the actual entity scope
  in `entity_type` column. The filter dropdown has separate
  checkboxes for `lead_linked`, `contact_linked`, `company_linked`
  etc.; render-time matching expands them to
  `entity_linked WHERE entity_type='lead'` and so on.

**Idle minutes (grey):**
- `total - callMin - crmMin`, clamped to ≥0.
- Captures real downtime + 1h lunch break (not separately marked) +
  any passive-Kommo-viewing where no event was emitted (limit of
  Kommo telemetry, not our pipeline).

---

## Performance — stale-while-revalidate

`/api/tracking` GET serves immediately from `tracking_events` cache,
even if data is up to ~5 minutes old. Background sync to Kommo runs
fire-and-forget so the page doesn't block on rate-limited API calls
(`route.ts:85-110`).

| Mode | Latency |
|---|---|
| Cache hit (data already there) | ~50-200ms |
| Cache miss (user picked an uncached date range) | 5-30s while `ensureRangeCached` backfills synchronously |

If a user picks a date range months back that hasn't been
backfilled, run the offline script instead of waiting on the GET:

```bash
npx tsx scripts/backfill-tracking.ts --from 2026-01-01 --to 2026-04-28
```

---

## Filter UI

Two dropdowns in the control bar:

1. **Типы событий** — multi-select for the 39 CRM types (calls are
   always on, blue). Default: all selected. Initial state from
   `DEFAULT_SELECTED_KEYS`.
2. **Менеджеры** — multi-select grouped by line (Линия 1/2/3/Без
   линии). Default: all selected. Resets on department switch.
   `null` = all (no `managers=` query param sent), `Set` = whitelist.

Both filter selections are part of the cache key — flipping a
checkbox doesn't re-fetch from Kommo, just re-filters the cached
events client-side.

---

## CURRENT_FILTER_VERSION history

Bumped any time the Kommo fetch logic changes in a way that
invalidates past cache. On mismatch, `ensureRangeCached` re-backfills
90 days.

| Version | Date | What changed |
|---|---|---|
| v0 | — | Pre-filter-bug |
| v1 | — | Explicit `filter[type][]` |
| v2 | — | Tried `filter[entity]` as comma-list (broken) |
| v3 | — | Reverted `filter[entity]` |
| v4 | — | Per-entity loop with single-value `filter[entity]` |
| v5 | — | Force re-backfill after upsertSyncState bug fix |
| v6 | — | Drop `customer` entity (Kommo /events doesn't accept it) |
| v7 | 2026-04-28 | Calls via `/notes` instead of `/events` (filter[created_by] gap) |
| v8 | 2026-04-28 | `filter[updated_at]` instead of `filter[created_at]` on /notes |
| v9 | 2026-04-28 | Corrected 19 wrong type-keys against Kommo /events/types catalogue |
| v10 | 2026-04-28 | Capture full Kommo call params (uniq, pbx_source, link, phone, call_status, call_result) in `raw` JSONB |
| **v11** | 2026-04-28 | Include `role='rop' AND line IS NOT NULL` in manager attribution (Татьяна Дерикова case) ← current |

---

## Backfill volumes (post v11, 2026-01-01 → 2026-04-28)

| Dept | Total rows | Calls (in/out + missed) | CRM events |
|---|---|---|---|
| b2g | 240,782 | 68,526 (+25,448 missed) | 179,031 |
| b2b | 139,005 | 28,989 | 113,706 |
| **Total** | **379,787** | **97,515** | **292,737** |

Coverage: 41/41 declared types observed across both depts. 14 active
b2g managers + 11 active b2b + Дерикова (rop+line=2) all attributed.

---

## Useful endpoints

```bash
# Per-day breakdown by event_type + per-manager
GET /api/tracking/debug?department=b2g&from=2026-04-01&to=2026-04-28

# Force a specific window backfill (avoids 90-day cap inside ensureRangeCached)
POST /api/tracking/sync?department=b2g&from=2026-01-01&to=2026-04-28

# Force a fresh sync ignoring debounce
POST /api/tracking/sync?department=b2g&force=1
```

```bash
# Offline chunked backfill (when on-demand would time out the HTTP request)
npx tsx scripts/backfill-tracking.ts --from 2026-01-01 --to 2026-04-28
npx tsx scripts/backfill-tracking.ts --dept b2g --days 30
npx tsx scripts/backfill-tracking.ts --chunk 3              # 3-day chunks
```

---

## Files

```
src/lib/tracking/sync.ts            ← writes tracking_events, attribution map
src/lib/tracking/timeline.ts        ← per-minute call/crm/idle math
src/lib/tracking/event-types.ts     ← 41 declared types + per-id normalizer
src/lib/tracking/init.ts            ← schema bootstrap

src/lib/kommo/client.ts             ← getAllCallNotesByDate, fetchRawEvents
src/lib/db/schema-tracking.ts       ← tracking_events + tracking_sync_state

src/app/api/tracking/route.ts       ← GET — read-time stale-while-revalidate
src/app/api/tracking/sync/route.ts  ← POST — manual force/backfill trigger
src/app/api/tracking/debug/route.ts ← per-day breakdown for diagnostics

src/components/TrackingTab.tsx      ← UI, two filter dropdowns + control bar

scripts/backfill-tracking.ts        ← offline chunked backfill + coverage report

docs/DASHBOARD-AKTIVNOST.md         ← this file
```
