// POST /api/analytics/sync
// Triggers ETL sync for a date range. Admin-only.
//
// Body: { from?: "YYYY-MM-DD", to?: "YYYY-MM-DD", skip?: string[] }
// Response: { success: true, result: SyncResult }

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { runSync } from "@/lib/etl";
import { addDaysCivil, parseDateBoundary, todayCivil } from "@/lib/utils/date";

export const maxDuration = 300; // 5-minute timeout (Vercel/Dokploy Pro)

export async function POST(req: NextRequest): Promise<NextResponse> {
  void req; // used below for body parsing
  try {
    const session = await getSession();
    if (!session || session.role !== "admin") {
      return NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 });
    }

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

    const fromStr = typeof body.from === "string" ? body.from : null;
    const toStr = typeof body.to === "string" ? body.to : null;

    // Default window: last 30 Berlin days through end-of-today Berlin. Civil-
    // date math (not millisecond) so a DST flip inside the 30-day span doesn't
    // shave or add an extra hour at one end.
    const today = todayCivil();
    const fromCivil = fromStr ?? addDaysCivil(today, -30);
    const toCivil = toStr ?? today;

    if (!/^\d{4}-\d{2}-\d{2}$/.test(fromCivil) || !/^\d{4}-\d{2}-\d{2}$/.test(toCivil)) {
      return NextResponse.json({ success: false, error: "Invalid date format" }, { status: 400 });
    }

    const fromDate = parseDateBoundary(fromCivil, "start");
    const toDate = parseDateBoundary(toCivil, "end");
    if (!fromDate || !toDate) {
      return NextResponse.json({ success: false, error: "Invalid date format" }, { status: 400 });
    }

    if (fromDate > toDate) {
      return NextResponse.json({ success: false, error: "from must be before to" }, { status: 400 });
    }

    const skip = Array.isArray(body.skip) ? body.skip as string[] : undefined;

    const result = await runSync({ fromDate, toDate, skip: skip as Parameters<typeof runSync>[0]["skip"] });

    return NextResponse.json({ success: true, result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal error";
    console.error("[Analytics Sync]", error);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
