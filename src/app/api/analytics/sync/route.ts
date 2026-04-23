// POST /api/analytics/sync
// Triggers ETL sync for a date range. Admin-only.
//
// Body: { from?: "YYYY-MM-DD", to?: "YYYY-MM-DD", skip?: string[] }
// Response: { success: true, result: SyncResult }

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { runSync } from "@/lib/etl";

export const maxDuration = 300; // 5-minute timeout (Vercel/Dokploy Pro)

export async function POST(req: NextRequest): Promise<NextResponse> {
  void req; // used below for body parsing
  try {
    const session = await getSession();
    if (!session || session.role !== "admin") {
      return NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 });
    }

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

    const today = new Date();
    today.setUTCHours(23, 59, 59, 999);

    const fromStr = typeof body.from === "string" ? body.from : null;
    const toStr = typeof body.to === "string" ? body.to : null;

    const fromDate = fromStr
      ? new Date(`${fromStr}T00:00:00Z`)
      : new Date(today.getTime() - 30 * 86400 * 1000); // default: last 30 days

    const toDate = toStr ? new Date(`${toStr}T23:59:59Z`) : today;

    if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
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
