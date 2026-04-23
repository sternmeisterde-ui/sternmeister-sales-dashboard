import { trackingDb } from "@/lib/db/tracking-db";
import { trackingEvents, trackingSyncState } from "@/lib/db/schema-tracking";
import { db as d1Db } from "@/lib/db";
import { masterManagers } from "@/lib/db/schema-existing";
import { eq, and } from "drizzle-orm";
import { fetchRawEvents, getCallNotes } from "@/lib/kommo/client";
import { ensureTrackingSchema } from "./init";
import { CALL_TYPES } from "./event-types";
import type { DepartmentId } from "@/lib/config/tenant";

export type Dept = DepartmentId;

const SYNC_MIN_INTERVAL_MS = 60_000; // debounce concurrent triggers
const BACKFILL_HOURS_ON_FIRST_RUN = 24; // first ever sync covers last 24h

/** Load Kommo-linked managers for a department. */
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
  opts?: { force?: boolean },
): Promise<{ inserted: number; windowFrom: Date; windowTo: Date; skipped?: string }> {
  await ensureTrackingSchema();

  const state = await getSyncState(department);
  const now = new Date();

  // Debounce: if someone else just synced, skip (unless forced).
  if (!opts?.force && state?.lastSyncedAt) {
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
  const windowTo = now;
  let windowFrom: Date;
  if (state?.lastEventTs) {
    windowFrom = new Date(new Date(state.lastEventTs).getTime() - 60 * 60_000); // 1h overlap
  } else {
    windowFrom = new Date(now.getTime() - BACKFILL_HOURS_ON_FIRST_RUN * 60 * 60_000);
  }

  const dateFromSec = Math.floor(windowFrom.getTime() / 1000);
  const dateToSec = Math.floor(windowTo.getTime() / 1000);

  // Manager list
  const managers = await getManagersForDept(department);
  if (managers.length === 0) {
    await upsertSyncState(department, now, state?.lastEventTs ?? null, null);
    return { inserted: 0, windowFrom, windowTo, skipped: "no managers with kommo_user_id" };
  }

  const kommoUserIds = managers.map((m) => m.kommoUserId);
  const kommoIdToManager = new Map(managers.map((m) => [m.kommoUserId, m.id]));

  try {
    // Fetch all events (no type filter — we cache everything; UI filters later)
    // and call notes (for duration enrichment) in parallel.
    const [events, callNotes] = await Promise.all([
      fetchRawEvents(dateFromSec, dateToSec, { kommoUserIds }),
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

    if (events.length > 0) {
      // Batch insert with ON CONFLICT DO NOTHING
      const rowsToInsert = events
        .map((ev) => {
          const managerId = kommoIdToManager.get(ev.createdBy);
          if (!managerId) return null; // event from user who isn't in our manager list — skip

          const evTs = new Date(ev.createdAt * 1000);
          if (evTs > maxEventTs) maxEventTs = evTs;

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

    await upsertSyncState(department, now, maxEventTs, null);
    return { inserted, windowFrom, windowTo };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[tracking-sync] ${department} failed:`, msg);
    await upsertSyncState(department, now, state?.lastEventTs ?? null, msg);
    throw err;
  }
}

async function upsertSyncState(
  department: Dept,
  lastSyncedAt: Date,
  lastEventTs: Date | null,
  lastError: string | null,
): Promise<void> {
  await trackingDb
    .insert(trackingSyncState)
    .values({
      department,
      lastSyncedAt,
      lastEventTs,
      lastError,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: trackingSyncState.department,
      set: {
        lastSyncedAt,
        lastEventTs,
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
