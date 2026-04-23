// GET /api/analytics/sync/cron
// Incremental ETL sync triggered by an external scheduler (Dokploy cron / system cron).
// Fetches leads updated in the last WINDOW_MINUTES + communications created in the same window.
// Protected by CRON_SECRET — no session cookie required (cron jobs have no browser).
//
// Call: GET /api/analytics/sync/cron?secret=<CRON_SECRET>
// Or:   GET /api/analytics/sync/cron  with header  x-cron-secret: <CRON_SECRET>

import { type NextRequest, NextResponse } from "next/server";
import { runSync } from "@/lib/etl";

export const maxDuration = 300;
// Next.js must not cache this route
export const dynamic = "force-dynamic";

// Overlap window in minutes — slightly larger than the cron interval so we never
// miss an event that landed between two ticks.
const WINDOW_MINUTES = 15;

export async function GET(req: NextRequest): Promise<NextResponse> {
  const secret =
    req.headers.get("x-cron-secret") ??
    req.nextUrl.searchParams.get("secret");

  const expected = process.env.CRON_SECRET;
  if (!expected) {
    console.error("[ETL cron] CRON_SECRET env var not set");
    return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
  }
  if (!secret || secret !== expected) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const toDate = new Date();
  const fromDate = new Date(toDate.getTime() - WINDOW_MINUTES * 60 * 1000);

  console.log(
    `[ETL cron] incremental sync window: ${fromDate.toISOString()} → ${toDate.toISOString()}`,
  );

  try {
    const result = await runSync({ fromDate, toDate, incremental: true });
    return NextResponse.json({ success: true, result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal error";
    console.error("[ETL cron] sync failed:", error);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
