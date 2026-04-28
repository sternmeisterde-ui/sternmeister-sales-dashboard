// GET /api/tracking/debug?department=b2g&from=2026-04-27&to=2026-04-28
//
// Diagnostic for tracking_events. Reports what's actually in the DB so we
// can compare against what Kommo / Simple Sales reports — confirms whether
// underfetch is in the sync layer (DB has too few events) or render layer
// (DB has them but timeline drops them).

import { NextRequest, NextResponse } from "next/server";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import { trackingDb } from "@/lib/db/tracking-db";
import { trackingEvents, trackingSyncState } from "@/lib/db/schema-tracking";
import { ensureTrackingSchema } from "@/lib/tracking/init";
import { getInvalidEventTypes } from "@/lib/kommo/client";

export const dynamic = "force-dynamic";

function parseDate(s: string | null, fallback: Date): Date {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return fallback;
  return new Date(`${s}T00:00:00Z`);
}

export async function GET(req: NextRequest) {
  try {
    await ensureTrackingSchema();
    const url = new URL(req.url);
    const department = url.searchParams.get("department");
    if (department !== "b2g" && department !== "b2b") {
      return NextResponse.json({ error: "department must be b2g or b2b" }, { status: 400 });
    }
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const yesterday = new Date(today.getTime() - 24 * 60 * 60_000);
    const from = parseDate(url.searchParams.get("from"), yesterday);
    const to = parseDate(url.searchParams.get("to"), new Date(today.getTime() + 24 * 60 * 60_000));

    // Total count + breakdown by event_type for this department/window.
    const byType = await trackingDb
      .select({
        eventType: trackingEvents.eventType,
        count: sql<number>`count(*)::int`,
      })
      .from(trackingEvents)
      .where(
        and(
          eq(trackingEvents.department, department),
          gte(trackingEvents.createdAt, from),
          lt(trackingEvents.createdAt, to),
        ),
      )
      .groupBy(trackingEvents.eventType)
      .orderBy(sql`count(*) DESC`);

    // Per-manager total + breakdown.
    const byManager = await trackingDb
      .select({
        managerId: trackingEvents.managerId,
        count: sql<number>`count(*)::int`,
        callCount: sql<number>`count(*) FILTER (WHERE event_type IN ('incoming_call','outgoing_call'))::int`,
        crmCount: sql<number>`count(*) FILTER (WHERE event_type NOT IN ('incoming_call','outgoing_call'))::int`,
      })
      .from(trackingEvents)
      .where(
        and(
          eq(trackingEvents.department, department),
          gte(trackingEvents.createdAt, from),
          lt(trackingEvents.createdAt, to),
        ),
      )
      .groupBy(trackingEvents.managerId)
      .orderBy(sql`count(*) DESC`);

    const [state] = await trackingDb
      .select()
      .from(trackingSyncState)
      .where(eq(trackingSyncState.department, department))
      .limit(1);

    const total = byType.reduce((s, r) => s + Number(r.count), 0);
    return NextResponse.json({
      department,
      window: { from: from.toISOString(), to: to.toISOString() },
      totals: {
        events: total,
        managersWithEvents: byManager.length,
      },
      syncState: state
        ? {
            lastSyncedAt: state.lastSyncedAt,
            lastEventTs: state.lastEventTs,
            earliestEventTs: state.earliestEventTs,
            filterVersion: state.filterVersion,
            lastError: state.lastError,
          }
        : null,
      blacklist: getInvalidEventTypes(),
      byType: byType.map((r) => ({ type: r.eventType, count: Number(r.count) })),
      byManager: byManager.map((r) => ({
        managerId: r.managerId,
        total: Number(r.count),
        calls: Number(r.callCount),
        crm: Number(r.crmCount),
      })),
    });
  } catch (err) {
    console.error("[tracking/debug] error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
