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
const CURRENT_FILTER_VERSION = 1;

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

  try {
    // Fetch events for every type we track (explicit `filter[type][]` — Kommo
    // without it returns an unreliable mix that drops most CRM activity) and
    // call notes (for duration enrichment) in parallel.
    const [events, callNotes] = await Promise.all([
      fetchRawEvents(dateFromSec, dateToSec, {
        kommoUserIds,
        types: ALL_TRACKED_EVENT_TYPES,
      }),
      getCallNotes(dateFromSec, dateToSec, kommoUserIds).catch((err) => {
        console.warn(`[tracking-sync] getCallNotes failed: ${err?.message}; calls will have 0 duration`);
        return [];
      }),
    ]);

    // Build noteId -> duration map
    const durationByNoteId = new Map<number, number>();
    for (const note of callNotes) {
      const dur = Number(note.params?.duration) || 0;
      if (dur > 0) durationByNoteId.set(note.id, dur);
    }

    // Upsert events
    let inserted = 0;
    let maxEventTs = state?.lastEventTs ? new Date(state.lastEventTs) : new Date(0);
    let minEventTs: Date | null = state?.earliestEventTs ? new Date(state.earliestEventTs) : null;

    if (events.length > 0) {
      // Batch insert with ON CONFLICT DO NOTHING
      const rowsToInsert = events
        .map((ev) => {
          const managerId = kommoIdToManager.get(ev.createdBy);
          if (!managerId) return null; // event from user who isn't in our manager list — skip

          const evTs = new Date(ev.createdAt * 1000);
          if (evTs > maxEventTs) maxEventTs = evTs;
          if (!minEventTs || evTs < minEventTs) minEventTs = evTs;

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

      if (rowsToInsert.length > 0) {
        // Chunked insert — Neon HTTP caps payload size per call.
        const CHUNK = 500;
        for (let i = 0; i < rowsToInsert.length; i += CHUNK) {
          const chunk = rowsToInsert.slice(i, i + CHUNK);
          const result = await trackingDb
            .insert(trackingEvents)
            .values(chunk)
            .onConflictDoNothing({ target: [trackingEvents.department, trackingEvents.eventId] })
            .returning({ id: trackingEvents.id });
          inserted += result.length;
        }
      }
    }

    // earliestEventTs watermark — extend to whichever is earlier: the sync
    // window's floor (ensures we mark the full range as "covered" even if
    // Kommo returned no events in the early part of it), or the oldest event
    // we actually observed.
    const effectiveEarliest = minEventTs && minEventTs < windowFrom ? minEventTs : windowFrom;
    const newEarliest = state?.earliestEventTs
      ? new Date(Math.min(new Date(state.earliestEventTs).getTime(), effectiveEarliest.getTime()))
      : effectiveEarliest;

    await upsertSyncState(department, now, maxEventTs, newEarliest, null);
    return { inserted, windowFrom, windowTo };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[tracking-sync] ${department} failed:`, msg);
    await upsertSyncState(
      department,
      now,
      state?.lastEventTs ?? null,
      state?.earliestEventTs ? new Date(state.earliestEventTs) : null,
      msg,
    );
    throw err;
  }
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
