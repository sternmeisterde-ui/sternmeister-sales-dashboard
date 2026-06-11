import { trackingDb } from "@/lib/db/tracking-db";
import { trackingEvents, trackingSyncState } from "@/lib/db/schema-tracking";
import { db as d1Db } from "@/lib/db";
import { masterManagers } from "@/lib/db/schema-existing";
import { eq, and, or, isNotNull, sql } from "drizzle-orm";
import { fetchRawEvents } from "@/lib/kommo/client";
import { ensureTrackingSchema } from "./init";
import { CALL_TYPES, EVENT_TYPES } from "./event-types";

// CRM (non-call) event types only. Calls are NOT synced from Kommo /notes
// here anymore — /api/tracking now sources them from analytics.communications,
// which is fed by our own direct-from-АТС ETL (sync-telephony pulls CallGear+
// CloudTalk CDR; sync-communications adds Kommo-side context). So Активность
// agrees with Звонки/Daily/Dashboard and survives Kommo PBX-integration
// outages. The CALL_TYPES filter below keeps the safety net in case the
// catalogue ever regains a non-PBX call type.
const NON_CALL_EVENT_TYPES = EVENT_TYPES
  .filter((t) => !CALL_TYPES.has(t.key))
  .map((t) => t.key);
import type { DepartmentId } from "@/lib/config/tenant";

export type Dept = DepartmentId;

const SYNC_MIN_INTERVAL_MS = 60_000; // debounce concurrent triggers
const BACKFILL_HOURS_ON_FIRST_RUN = 24; // first ever sync covers last 24h
const MAX_BACKFILL_DAYS = 90;        // safety cap — one user request can't pull > 90 days of Kommo

// Bump this when the Kommo fetch logic changes in a way that invalidates past
// cache. On next sync, ensureRangeCached detects the version mismatch, resets
// earliest_event_ts, and re-backfills MAX_BACKFILL_DAYS so admins don't need
// to trigger manual /api/tracking/sync?from=…&to=… calls per department.
//
//   v0 — pre-filter-bug (no filter[type][], only calls landed reliably)
//   v1 — explicit filter[type][] with EVENT_TYPES batches (2026-04-24 fix)
//   v2 — corrected Kommo syntax per docs: filter[type]/filter[created_by]
//        as comma-separated strings, added filter[entity] covering contact/
//        company/customer/task (was defaulting to lead-only, which dropped
//        ~half of CRM events), bumped limit 100 → 250 (2026-04-25)
//   v3 — reverted filter[entity]: Kommo treats it as single-value, not
//        comma-list, so v2 was parsed as entity=lead and broke all multi-
//        entity batches. The v2 run also poisoned the in-process blacklist
//        with non-lead-valid types. v3 clears blacklist on restart and
//        re-backfills without filter[entity]. Proper per-entity loop is
//        a follow-up; for now we accept lead-scoped default coverage.
//   v4 — fetchRawEvents now loops KOMMO_ENTITIES (lead/contact/company/
//        customer/task) per Kommo's single-value filter[entity] contract,
//        with a PER-ENTITY blacklist so types valid for one entity aren't
//        globally suppressed. Covers previously-missed contact/company/
//        customer/task events — main cause of CRM (green) underfetch and
//        also fixes dashboard call undercount via getCallEvents→fetchRawEvents
//        delegation. (2026-04-25)
//   v5 — force re-backfill after fixing upsertSyncState bug where a failed
//        re-backfill was silently advancing filter_version, earliestEventTs
//        and lastEventTs in the DB — masking the failure and leaving
//        tracking_events with gaps on non-lead entities. v5 re-triggers
//        the 90d backfill on next tab open so partial-fail data is
//        completed. (2026-04-25)
//   v6 — dropped `customer` from KOMMO_ENTITIES (Kommo /events docs don't
//        accept it as filter[entity]; v4/v5 blacklisted everything under
//        the failing customer iteration, wasting ~1/4 of rate-limit budget
//        per sync). Re-backfill so prior runs' poisoned blacklists clear.
//        (2026-04-28)
//   v7 — call events now sourced from /{entity}/notes via getAllCallNotes-
//        ByDate instead of /events. The /events path requires filter[
//        created_by] which silently dropped any call created by a PBX
//        integration's service user, even when the manager who actually
//        handled the call was the lead's responsible_user. /notes has no
//        such filter — we get every call and attribute via createdBy with
//        responsibleUserId fallback. Same fix as ETL commit f70e8f5.
//        (2026-04-28)
//   v8 — getAllCallNotesByDate was sending filter[created_at][from/to],
//        but Kommo's /{entity}/notes endpoint only documents
//        filter[updated_at]. The created_at filter was silently ignored
//        and the endpoint returned the most recent 250 notes overall —
//        dominated by chat messages on busy accounts — so v7's call
//        backfill landed almost zero call rows. Switched to
//        filter[updated_at][from/to] (≡ created_at for unedited PBX call
//        notes, which is the overwhelming majority). Force re-backfill so
//        v7-shaped tracking_events get the missing calls. (2026-04-28)
//   v9 — corrected EVENT_TYPES keys to match Kommo's canonical /events/types
//        catalogue. 19 type-keys were guesses that 400'd at the API and got
//        permanently blacklisted on first sync after each restart, dropping
//        whole categories of CRM activity from the timeline:
//          • emails: incoming_email/outgoing_email → incoming_mail/outgoing_mail
//          • merges: entities_merged → entity_merged
//          • segments: segment_added/removed → entity_segment_attached/detached
//          • retargeting: retargeting_added/removed → targeting_in/out_note_added
//          • sales: purchase_added → transaction_added; cashier_message → message_to_cashier_note_added
//          • site: site_visit → site_visit_note_added
//          • AI: kommo_ai → ai_result; key_action → key_action_completed
//          • talks: no_reply_needed → conversation_answered; reply_time_exceeded → talk_missed_event
//          • subscriptions: subscribed/unsubscribed → meta_chat_subscription_added/removed
//          • files: dropbox_note_added → dropbox_attachment
//          • fields: ltv_changed → ltv_field_changed; question_topic_defined → intent_identified
//        Also added entity_direct_message (Внутреннее сообщение) and unblocked
//        incoming_chat_message which is now in Kommo's catalogue. Per-field-id
//        custom_field_<ID>_value_changed events normalise to the generic key in
//        the timeline render so one checkbox covers all field changes.
//        Re-backfill picks up everything that was previously dropped. (2026-04-28)
//   v10 — captured full Kommo call params in raw JSONB (uniq, pbx_source,
//        link, phone, call_status, call_result). Pre-v10 rows have only
//        {source, call_status} in raw — to keep tracking_events clean of
//        stale partials, the user TRUNCATEd the table along with this bump.
//        Re-backfill repopulates with full raw + corrected v9 type-keys.
//        (2026-04-28)
//   v11 — getManagersForDept now includes role='rop' WITH non-null line
//        (the "double-status" convention — Татьяна Дерикова line=2 takes
//        calls and runs the team simultaneously). v10 sync filtered her
//        out via role='manager' alone, so her calls landed under no
//        attribution and were dropped. Re-backfill picks them up.
//        (2026-04-28)
//   v12 — calls no longer synced into tracking_events at all. /api/tracking
//        now reads call segments from analytics.communications, fed by our
//        own ETL (sync-telephony: direct CallGear+CloudTalk CDR pulls;
//        sync-communications: Kommo-side notes). Same source as Звонки/
//        Daily/Dashboard. Reasons:
//          • Kommo /notes only sees calls when the PBX integration is
//            healthy; CloudTalk/CallGear outages caused multi-hour gaps in
//            Активность (incident 2026-04-29 b2b, 2026-04-30 b2g).
//          • Звонки and Активность previously disagreed because they read
//            from different sources — now both go through analytics.
//        Re-backfill purges legacy "note:*" call rows from tracking_events
//        below so the timeline isn't double-counting historic calls
//        alongside the new analytics source. (2026-04-30)
//   v13 — getManagersForDept now also includes role='teamlead' (new role:
//        admin-level dashboard access, but works the line like a manager, so
//        their CRM activity belongs in attribution). Existing teamlead-less
//        installs are unaffected; bump still forces the standard 90-day
//        re-backfill per the filter-version contract. (2026-06-11)
const CURRENT_FILTER_VERSION = 13;

/** Load Kommo-linked managers for a department.
 *
 * Includes:
 *   • role='manager' — the canonical case
 *   • role='teamlead' — admin-level UI access, but takes calls like a
 *     manager, so their activity is always attributed
 *   • role='rop' WITH non-null line — the "double-status" convention
 *     documented in memory/project_double_status.md. Татьяна Дерикова is
 *     role='rop', line='2' — she takes line-2 calls AND runs the team, and
 *     her per-day activity belongs in the timeline. ROPs without a line
 *     (e.g. Дмитрий, line=null) stay excluded — they coordinate, don't
 *     sit on the dialler.
 *
 * Inactive managers are dropped via isActive=true, so a re-pull from
 * 2026-01-01 won't pollute the cache with people who already left — the
 * attribution map only contains current staff. New hires naturally appear
 * only from their first Kommo activity since their kommoUserId didn't
 * exist (or wasn't in master_managers) before that.
 */
async function getManagersForDept(department: Dept) {
  const rows = await d1Db
    .select({
      id: masterManagers.id,
      kommoUserId: masterManagers.kommoUserId,
    })
    .from(masterManagers)
    .where(
      and(
        eq(masterManagers.department, department),
        eq(masterManagers.isActive, true),
        or(
          eq(masterManagers.role, "manager"),
          eq(masterManagers.role, "teamlead"),
          and(eq(masterManagers.role, "rop"), isNotNull(masterManagers.line)),
        ),
      ),
    );
  return rows.filter((r): r is { id: string; kommoUserId: number } => r.kommoUserId !== null);
}

/** Read current sync state row (or undefined if none). */
async function getSyncState(department: Dept) {
  const [row] = await trackingDb
    .select()
    .from(trackingSyncState)
    .where(eq(trackingSyncState.department, department))
    .limit(1);
  return row;
}

/**
 * Run a delta-sync for one department.
 *
 * Strategy:
 *  - Window = [last_event_ts - 1h, now]   (1h overlap absorbs clock skew / late
 *    events; dedup via (department, event_id) unique index).
 *  - On first ever run: window = [now - 24h, now].
 *  - Only managers with a resolved kommoUserId are pulled.
 *  - Call durations fetched via getCallNotes (cached ~2 min) for the same window.
 *
 * Returns number of new events inserted.
 */
export async function syncDepartment(
  department: Dept,
  opts?: { force?: boolean; windowFrom?: Date; windowTo?: Date; isBackfill?: boolean },
): Promise<{ inserted: number; windowFrom: Date; windowTo: Date; skipped?: string }> {
  await ensureTrackingSchema();

  const state = await getSyncState(department);
  const now = new Date();

  // Debounce only for default (delta) syncs — backfills target a specific past
  // window and shouldn't be rate-limited against delta syncs.
  if (!opts?.force && !opts?.isBackfill && !opts?.windowFrom && state?.lastSyncedAt) {
    const sinceLast = now.getTime() - new Date(state.lastSyncedAt).getTime();
    if (sinceLast < SYNC_MIN_INTERVAL_MS) {
      return {
        inserted: 0,
        windowFrom: new Date(state.lastEventTs ?? now),
        windowTo: now,
        skipped: `synced ${Math.floor(sinceLast / 1000)}s ago`,
      };
    }
  }

  // Compute window
  let windowTo: Date;
  let windowFrom: Date;
  if (opts?.windowFrom && opts?.windowTo) {
    windowFrom = opts.windowFrom;
    windowTo = opts.windowTo;
  } else {
    windowTo = now;
    if (state?.lastEventTs) {
      windowFrom = new Date(new Date(state.lastEventTs).getTime() - 60 * 60_000); // 1h overlap
    } else {
      windowFrom = new Date(now.getTime() - BACKFILL_HOURS_ON_FIRST_RUN * 60 * 60_000);
    }
  }

  const dateFromSec = Math.floor(windowFrom.getTime() / 1000);
  const dateToSec = Math.floor(windowTo.getTime() / 1000);

  // Manager list
  const managers = await getManagersForDept(department);
  if (managers.length === 0) {
    // Nothing to sync but don't disturb watermarks/filter_version — treat as
    // a no-op success so the debounce kicks in but a future run with a
    // populated manager list still does the full re-backfill if needed.
    await upsertSyncStateOnSuccess(
      department,
      now,
      state?.lastEventTs ? new Date(state.lastEventTs) : null,
      state?.earliestEventTs ? new Date(state.earliestEventTs) : null,
    );
    return { inserted: 0, windowFrom, windowTo, skipped: "no managers with kommo_user_id" };
  }

  const kommoUserIds = managers.map((m) => m.kommoUserId);
  const kommoIdToManager = new Map(managers.map((m) => [m.kommoUserId, m.id]));

  // Durable progress counters. Mutated inside the streaming onBatch callback
  // so a mid-sync crash still leaves the watermark reflecting what actually
  // made it to the DB (tracked in the `finally` block below).
  let inserted = 0;
  let maxEventTs = state?.lastEventTs ? new Date(state.lastEventTs) : new Date(0);
  let minEventTs: Date | null = state?.earliestEventTs ? new Date(state.earliestEventTs) : null;
  let fatalError: unknown = null;

  // Helper: chunked insert + watermark advance, shared between calls and
  // CRM-events paths. Insert before watermark mutation so a mid-chunk
  // failure leaves the DB and watermark consistent.
  const persistRows = async (
    rows: Array<typeof trackingEvents.$inferInsert>,
  ) => {
    const CHUNK = 500;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      const result = await trackingDb
        .insert(trackingEvents)
        .values(chunk)
        .onConflictDoNothing({ target: [trackingEvents.department, trackingEvents.eventId] })
        .returning({ id: trackingEvents.id });
      inserted += result.length;
      for (const row of chunk) {
        if (row.createdAt > maxEventTs) maxEventTs = row.createdAt;
        if (!minEventTs || row.createdAt < minEventTs) minEventTs = row.createdAt;
      }
    }
  };

  // Manager attribution: try the event's createdBy first (manager actually
  // clicked / picked up). Fall back to the entity's responsibleUserId for
  // PBX-routed calls where createdBy is a service user. Returns null if no
  // master_managers row matches either — such events skip the cache (still
  // in Kommo, just not on this dashboard's manager-centric timeline).
  const attribute = (createdBy: number, responsibleUserId: number | null) => {
    let managerId = kommoIdToManager.get(createdBy);
    let kommoUserId = createdBy;
    if (!managerId && responsibleUserId != null) {
      managerId = kommoIdToManager.get(responsibleUserId);
      if (managerId) kommoUserId = responsibleUserId;
    }
    return managerId ? { managerId, kommoUserId } : null;
  };

  try {
    // CRM (non-call) events via /events with the per-entity loop +
    // blacklist (fetchRawEvents). Streamed so partial failures leave
    // already-fetched events durable.
    //
    // Calls intentionally NOT pulled here — /api/tracking reads them from
    // analytics.communications at render time (filter_version v12 note
    // above). Skipping the /notes pull also frees ~½ the per-sync Kommo
    // rate-limit budget for CRM coverage.
    await fetchRawEvents(dateFromSec, dateToSec, {
      kommoUserIds,
      types: NON_CALL_EVENT_TYPES,
      onBatch: async (batchEvents) => {
        const rows = batchEvents
          .map((ev) => {
            const attr = attribute(ev.createdBy, null);
            if (!attr) return null;
            return {
              department,
              managerId: attr.managerId,
              kommoUserId: attr.kommoUserId,
              eventId: String(ev.id),
              eventType: ev.type,
              createdAt: new Date(ev.createdAt * 1000),
              durationSec: 0, // CRM events are instantaneous
              entityType: ev.entityType,
              entityId: ev.entityId,
              noteId: ev.noteId,
              raw: ev.raw as unknown as Record<string, unknown>,
            };
          })
          .filter((r): r is NonNullable<typeof r> => r !== null);
        if (rows.length === 0) return;
        await persistRows(rows);
      },
    });
  } catch (err) {
    // fetchRawEvents only throws on fatal errors (auth). Everything else is
    // soft-skipped batch-by-batch. Stash it so we still persist the watermark
    // for whatever streamed through before the failure.
    fatalError = err;
    console.error(
      `[tracking-sync] ${department} aborted mid-stream (persisting partial progress):`,
      err instanceof Error ? err.message : String(err),
    );
  } finally {
    // Watermark policy:
    //  • On success: advance lastEventTs past the batches we observed, set
    //    filter_version to CURRENT, extend earliest_event_ts to cover the
    //    full window. The 1h-overlap on next delta absorbs late events.
    //  • On fatal error: KEEP everything pinned to the pre-sync state. This
    //    is critical: advancing filter_version to CURRENT on a failed re-
    //    backfill would mask the failure — ensureRangeCached's version
    //    check would pass and skip the re-backfill on next open, leaving
    //    tracking_events permanently incomplete. Same logic for
    //    earliest_event_ts and last_event_ts — any advance on partial
    //    progress risks skipping events from unfetched batches whose
    //    timestamps fall earlier than our streamed max − 1h.
    const lastErrorMsg = fatalError
      ? (fatalError instanceof Error ? fatalError.message : String(fatalError))
      : null;

    if (fatalError) {
      await upsertSyncStateOnFailure(department, now, state, lastErrorMsg);
    } else {
      const effectiveEarliest = minEventTs && minEventTs < windowFrom ? minEventTs : windowFrom;
      const newEarliest = state?.earliestEventTs
        ? new Date(Math.min(new Date(state.earliestEventTs).getTime(), effectiveEarliest.getTime()))
        : effectiveEarliest;
      await upsertSyncStateOnSuccess(department, now, maxEventTs, newEarliest);
    }
  }

  if (fatalError) throw fatalError;
  return { inserted, windowFrom, windowTo };
}

/**
 * Persist sync state after a successful sync. Advances filterVersion to
 * CURRENT so subsequent opens don't re-trigger backfill.
 */
async function upsertSyncStateOnSuccess(
  department: Dept,
  lastSyncedAt: Date,
  lastEventTs: Date | null,
  earliestEventTs: Date | null,
): Promise<void> {
  await trackingDb
    .insert(trackingSyncState)
    .values({
      department,
      lastSyncedAt,
      lastEventTs,
      earliestEventTs,
      filterVersion: CURRENT_FILTER_VERSION,
      lastError: null,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: trackingSyncState.department,
      set: {
        lastSyncedAt,
        lastEventTs,
        earliestEventTs,
        filterVersion: CURRENT_FILTER_VERSION,
        lastError: null,
        updatedAt: new Date(),
      },
    });
}

/**
 * Persist sync state after a fatal failure. Records the error for
 * observability and updates lastSyncedAt (so the debounce kicks in), but
 * preserves filterVersion / earliestEventTs / lastEventTs from the pre-sync
 * snapshot. Critical: if a re-backfill crashes mid-stream, the next open
 * MUST re-trigger it, which requires filterVersion to stay at the old value.
 */
async function upsertSyncStateOnFailure(
  department: Dept,
  lastSyncedAt: Date,
  previousState: TrackingSyncStateRow | undefined,
  lastError: string | null,
): Promise<void> {
  await trackingDb
    .insert(trackingSyncState)
    .values({
      department,
      lastSyncedAt,
      lastEventTs: previousState?.lastEventTs ?? null,
      earliestEventTs: previousState?.earliestEventTs ?? null,
      filterVersion: previousState?.filterVersion ?? 0,
      lastError,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: trackingSyncState.department,
      set: {
        lastSyncedAt,
        // Intentionally DO NOT update: lastEventTs, earliestEventTs,
        // filterVersion — they stay pinned to whatever was in the row
        // before this failed attempt, so the next invocation re-runs
        // the full backfill instead of assuming success.
        lastError,
        updatedAt: new Date(),
      },
    });
}

type TrackingSyncStateRow = Awaited<ReturnType<typeof getSyncState>>;

/**
 * Ensure cache is fresh enough before serving a request.
 * Returns true if a sync was actually performed.
 */
export async function ensureFreshSync(
  department: Dept,
  maxAgeSec = 300, // 5 min
): Promise<boolean> {
  await ensureTrackingSchema();
  const state = await getSyncState(department);
  if (!state?.lastSyncedAt) {
    await syncDepartment(department);
    return true;
  }
  const ageSec = (Date.now() - new Date(state.lastSyncedAt).getTime()) / 1000;
  if (ageSec > maxAgeSec) {
    await syncDepartment(department);
    return true;
  }
  return false;
}

/**
 * Ensure the cache covers events back to `fromDate`. If the earliest cached
 * event is later than requested, pull the missing window from Kommo.
 *
 * Returns true iff a backfill was actually performed.
 */
export async function ensureRangeCached(
  department: Dept,
  fromDate: Date,
): Promise<boolean> {
  await ensureTrackingSchema();
  const now = new Date();

  // Hard cap — don't let a malicious / mistyped UI request pull years of data.
  const maxFrom = new Date(now.getTime() - MAX_BACKFILL_DAYS * 24 * 60 * 60_000);
  const effectiveFrom = fromDate < maxFrom ? maxFrom : fromDate;

  const state = await getSyncState(department);

  // If we have no state yet, the normal delta-sync path handles it (24h backfill).
  // For past windows before any cache exists, we still need to pull them.
  if (!state) {
    await syncDepartment(department, {
      windowFrom: effectiveFrom,
      windowTo: now,
      isBackfill: true,
    });
    return true;
  }

  // Filter-version mismatch → past cache was built with an older fetch strategy
  // that missed event types. Re-pull the full MAX_BACKFILL_DAYS window so past
  // days auto-recover after a fetch-logic bugfix, without requiring an admin
  // to POST the manual /api/tracking/sync?from=…&to=… endpoint per department.
  if ((state.filterVersion ?? 0) < CURRENT_FILTER_VERSION) {
    const fullBackfillFrom = new Date(now.getTime() - MAX_BACKFILL_DAYS * 24 * 60 * 60_000);
    console.info(
      `[tracking-sync] ${department}: filter_version ${state.filterVersion ?? 0} < ${CURRENT_FILTER_VERSION}, forcing full ${MAX_BACKFILL_DAYS}d re-backfill`,
    );

    // v7 cleanup: pre-v7 call rows were keyed by /events' event_id (numeric
    // string like "12345"). v7 sources calls from /notes and prefixes the
    // key with "note:" — so a pre-v7 row and the v7 re-backfill's row for
    // the SAME physical call have different event_ids and both pass the
    // (department, event_id) unique constraint, double-counting in
    // timeline math. Drop the pre-v7 numeric-keyed call rows once before
    // we re-backfill so the result is single-sourced.
    if ((state.filterVersion ?? 0) < 7 && CURRENT_FILTER_VERSION >= 7) {
      const deleted = await trackingDb.execute(
        sql`DELETE FROM tracking_events
            WHERE department = ${department}
              AND event_type IN ('incoming_call', 'outgoing_call')
              AND event_id NOT LIKE 'note:%'`,
      );
      console.info(
        `[tracking-sync] ${department}: cleaned ${
          (deleted as { rowCount?: number }).rowCount ?? "?"
        } pre-v7 numeric-keyed call rows before re-backfill`,
      );
    }

    // v12 cleanup: calls now read from analytics.communications at render
    // time, never written to tracking_events. Purge ALL legacy call rows
    // (any prefix) once on upgrade so /api/tracking can't double-count
    // historic Kommo /notes rows alongside the new analytics source. Future
    // syncs only insert CRM types so the table stays call-free.
    if ((state.filterVersion ?? 0) < 12 && CURRENT_FILTER_VERSION >= 12) {
      const deleted = await trackingDb.execute(
        sql`DELETE FROM tracking_events
            WHERE department = ${department}
              AND event_type IN ('incoming_call', 'outgoing_call')`,
      );
      console.info(
        `[tracking-sync] ${department}: purged ${
          (deleted as { rowCount?: number }).rowCount ?? "?"
        } legacy call rows on v12 upgrade (calls now live in analytics.communications)`,
      );
    }

    await syncDepartment(department, {
      windowFrom: fullBackfillFrom,
      windowTo: now,
      isBackfill: true,
    });
    return true;
  }

  // If the requested window is already covered by our earliest watermark, done.
  if (state.earliestEventTs && new Date(state.earliestEventTs) <= effectiveFrom) {
    return false;
  }

  // Backfill the gap: [effectiveFrom, earliestEventTs ?? now]. Upper bound is
  // the current earliest — delta syncs handle everything above that.
  const upper = state.earliestEventTs ? new Date(state.earliestEventTs) : now;
  if (effectiveFrom >= upper) return false;

  await syncDepartment(department, {
    windowFrom: effectiveFrom,
    windowTo: upper,
    isBackfill: true,
  });
  return true;
}
