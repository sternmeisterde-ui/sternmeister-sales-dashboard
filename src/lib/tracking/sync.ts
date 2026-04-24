import { trackingDb } from "@/lib/db/tracking-db";
import { trackingEvents, trackingSyncState } from "@/lib/db/schema-tracking";
import { db as d1Db } from "@/lib/db";
import { masterManagers } from "@/lib/db/schema-existing";
import { eq, and } from "drizzle-orm";
import { fetchRawEvents, getCallNotes } from "@/lib/kommo/client";
import { ensureTrackingSchema } from "./init";
import { CALL_TYPES, EVENT_TYPES } from "./event-types";

// All event type keys we care about. Passed explicitly to Kommo `/events` via
// `filter[type][]` — without it, Kommo returns a mixed page dominated by
// system/robot events that fail our created_by → manager check, leaving
// almost no CRM activity in the cache (only calls pass through).
const ALL_TRACKED_EVENT_TYPES = EVENT_TYPES.map((t) => t.key);
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
const CURRENT_FILTER_VERSION = 4;

/** Load Kommo-linked managers for a department. Only role='manager' — the
 *  Tracking tab is about individual manager performance; ROPs/admins have
 *  different cadence and would skew timelines, so we keep them out of the
 *  cache entirely. */
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
        eq(masterManagers.role, "manager"),
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
    await upsertSyncState(
      department,
      now,
      state?.lastEventTs ?? null,
      state?.earliestEventTs ? new Date(state.earliestEventTs) : null,
      null,
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

  try {
    // Call notes first — needed for duration enrichment inside the events
    // callback. Soft-fails to empty map (calls get duration=0) so a /notes
    // outage doesn't block the much more important event capture.
    const callNotes = await getCallNotes(dateFromSec, dateToSec, kommoUserIds).catch((err) => {
      console.warn(`[tracking-sync] getCallNotes failed: ${err?.message}; calls will have 0 duration`);
      return [] as Awaited<ReturnType<typeof getCallNotes>>;
    });
    const durationByNoteId = new Map<number, number>();
    for (const note of callNotes) {
      const dur = Number(note.params?.duration) || 0;
      if (dur > 0) durationByNoteId.set(note.id, dur);
    }

    // Stream: fetchRawEvents invokes this for every successful (user × type)
    // batch. We insert immediately so partial sync failures still leave the
    // already-fetched events in the DB — the next run's delta window picks up
    // where this one stopped. Watermark counters are updated here so the
    // `finally` block can persist the real maximum even if we throw later.
    await fetchRawEvents(dateFromSec, dateToSec, {
      kommoUserIds,
      types: ALL_TRACKED_EVENT_TYPES,
      onBatch: async (batchEvents) => {
        // Phase 1: build rows. Do NOT mutate maxEventTs/minEventTs yet — if the
        // insert fails mid-chunk and the watermark has already advanced past an
        // event that's not in the DB, the next delta window skips it forever.
        const rowsToInsert = batchEvents
          .map((ev) => {
            const managerId = kommoIdToManager.get(ev.createdBy);
            if (!managerId) return null; // event created by user not in our manager set — skip
            const evTs = new Date(ev.createdAt * 1000);
            const isCall = CALL_TYPES.has(ev.type);
            const duration = isCall && ev.noteId ? (durationByNoteId.get(ev.noteId) ?? 0) : 0;
            return {
              department,
              managerId,
              kommoUserId: ev.createdBy,
              eventId: String(ev.id),
              eventType: ev.type,
              createdAt: evTs,
              durationSec: duration,
              entityType: ev.entityType,
              entityId: ev.entityId,
              noteId: ev.noteId,
              raw: ev.raw as unknown as Record<string, unknown>,
            };
          })
          .filter((r): r is NonNullable<typeof r> => r !== null);
        if (rowsToInsert.length === 0) return;

        // Phase 2: chunked insert. ON CONFLICT DO NOTHING absorbs cross-batch
        // and cross-sync duplicates (1h overlap window). After each chunk
        // succeeds, advance watermarks only for rows in that chunk — if a
        // later chunk throws, the watermark reflects exactly what's durable.
        const CHUNK = 500;
        for (let i = 0; i < rowsToInsert.length; i += CHUNK) {
          const chunk = rowsToInsert.slice(i, i + CHUNK);
          const result = await trackingDb
            .insert(trackingEvents)
            .values(chunk)
            .onConflictDoNothing({ target: [trackingEvents.department, trackingEvents.eventId] })
            .returning({ id: trackingEvents.id });
          inserted += result.length;
          // Chunk persisted. Advance watermarks over the rows we just wrote
          // (even duplicates count — they prove we've already seen the ts).
          for (const row of chunk) {
            if (row.createdAt > maxEventTs) maxEventTs = row.createdAt;
            if (!minEventTs || row.createdAt < minEventTs) minEventTs = row.createdAt;
          }
        }
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
    //  • On success: advance lastEventTs past the batches we observed. The
    //    1h-overlap in the next delta window catches any late-arriving event
    //    with a timestamp slightly before our max.
    //  • On fatal error: KEEP lastEventTs at the previous value. Already-
    //    persisted events are idempotent (ON CONFLICT DO NOTHING), and the
    //    next run re-covers the entire window. Advancing on partial progress
    //    would risk skipping events from unfetched batches whose timestamps
    //    fall earlier than our streamed max − 1h (Kommo events are not
    //    globally sorted across (user × type) batches).
    const effectiveEarliest = minEventTs && minEventTs < windowFrom ? minEventTs : windowFrom;
    const newEarliest = state?.earliestEventTs
      ? new Date(Math.min(new Date(state.earliestEventTs).getTime(), effectiveEarliest.getTime()))
      : effectiveEarliest;
    const lastErrorMsg = fatalError
      ? (fatalError instanceof Error ? fatalError.message : String(fatalError))
      : null;
    const persistedLastEventTs = fatalError
      ? (state?.lastEventTs ? new Date(state.lastEventTs) : null)
      : maxEventTs;
    await upsertSyncState(department, now, persistedLastEventTs, newEarliest, lastErrorMsg);
  }

  if (fatalError) throw fatalError;
  return { inserted, windowFrom, windowTo };
}

async function upsertSyncState(
  department: Dept,
  lastSyncedAt: Date,
  lastEventTs: Date | null,
  earliestEventTs: Date | null,
  lastError: string | null,
): Promise<void> {
  await trackingDb
    .insert(trackingSyncState)
    .values({
      department,
      lastSyncedAt,
      lastEventTs,
      earliestEventTs,
      filterVersion: CURRENT_FILTER_VERSION,
      lastError,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: trackingSyncState.department,
      set: {
        lastSyncedAt,
        lastEventTs,
        earliestEventTs,
        filterVersion: CURRENT_FILTER_VERSION,
        lastError,
        updatedAt: new Date(),
      },
    });
}

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
