// POST /api/tracking/sync?department=b2g&force=1
//   &from=2026-04-01&to=2026-04-24   ← optional explicit backfill window
//
// Triggers a Kommo → cache sync for one department. With from+to the call
// becomes a backfill that re-pulls events for that window (useful after a
// sync-logic bugfix has landed and past days are missing events — ordinary
// delta sync won't re-cover already-watermarked days).
import { NextRequest, NextResponse } from "next/server";
import { syncDepartment } from "@/lib/tracking/sync";

export const dynamic = "force-dynamic";

// Dates in the URL are Moscow calendar dates (same convention as the Dashboard
// GET route). Convert to UTC bounds using the same offset so backfills cover
// the full Moscow day, not the UTC day that happens to share the ISO prefix.
const DASHBOARD_TZ_OFFSET_MIN = 180;

function parseDateParam(s: string | null): Date | null {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return isNaN(d.getTime()) ? null : d;
}

export async function POST(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const department = url.searchParams.get("department");
    const force = url.searchParams.get("force") === "1";
    const fromParam = parseDateParam(url.searchParams.get("from"));
    const toParam = parseDateParam(url.searchParams.get("to"));
    if (department !== "b2g" && department !== "b2b") {
      return NextResponse.json({ error: "Invalid department" }, { status: 400 });
    }
    if ((fromParam && !toParam) || (!fromParam && toParam)) {
      return NextResponse.json(
        { error: "from and to must both be provided (or neither)" },
        { status: 400 },
      );
    }
    if (fromParam && toParam && fromParam > toParam) {
      return NextResponse.json({ error: "from > to" }, { status: 400 });
    }

    const syncOpts: Parameters<typeof syncDepartment>[1] = { force };
    if (fromParam && toParam) {
      // Moscow-local calendar dates → UTC bounds. Moscow midnight = UTC 21:00,
      // so the Moscow day ends 3h BEFORE the UTC day with the same ISO prefix.
      // Using plain +24h would miss events from 21:00-23:59 MSK.
      const windowFrom = new Date(
        fromParam.getTime() - DASHBOARD_TZ_OFFSET_MIN * 60_000,
      );
      const windowTo = new Date(
        toParam.getTime() + (24 * 60 - DASHBOARD_TZ_OFFSET_MIN) * 60_000,
      );
      syncOpts.windowFrom = windowFrom;
      syncOpts.windowTo = windowTo;
      syncOpts.isBackfill = true;
    }
    const res = await syncDepartment(department, syncOpts);
    return NextResponse.json(res);
  } catch (err) {
    console.error("[tracking/sync] error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

export const GET = POST;
