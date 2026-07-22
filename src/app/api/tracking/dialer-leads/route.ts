// GET /api/tracking/dialer-leads?department=b2g&from=2026-07-01&to=2026-07-22
// «Касания по лидам» table for the dialer view of the Активность tab:
// leads that were on Новый лид / Недозвон of the Бух Гос funnel AS OF the end
// of `to` (Berlin day; today → live Kommo-mirror state, past → reconstructed
// from lead_status_changes intervals), with call-touch counts split by
// attribution channel — cumulative to that date AND within [from, to].
import { NextRequest, NextResponse } from "next/server";
import { getDialerLeadTouches } from "@/lib/daily/analytics-calls";
import { tzOffsetMinutes } from "@/lib/utils/date";
import { getSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

function berlinDayStart(dateISO: string): Date {
  const dayUtc = new Date(`${dateISO}T00:00:00Z`);
  return new Date(dayUtc.getTime() - tzOffsetMinutes(dayUtc, "Europe/Berlin") * 60_000);
}

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const department = url.searchParams.get("department");
    const fromISO = url.searchParams.get("from");
    const toISO = url.searchParams.get("to") ?? fromISO;

    // Dialer is B2G-only (mirrors /api/tracking?view=dialer).
    if (department !== "b2g") {
      return NextResponse.json({ error: "Invalid department" }, { status: 400 });
    }
    // Same access policy as the tracking route: any authenticated session,
    // managers locked to their own department.
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (session.role === "manager" && session.department !== department) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    const isDate = (s: string | null): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
    if (!isDate(fromISO) || !isDate(toISO) || fromISO > toISO) {
      return NextResponse.json({ error: "Invalid date range" }, { status: 400 });
    }

    // Period = [00:00 of `from`, 24:00 of `to`] in Berlin. The upper bound is
    // also the cumulative "as of" instant (offsets from each bound for DST).
    const periodStart = berlinDayStart(fromISO);
    const toUtc = new Date(`${toISO}T00:00:00Z`);
    const asOfEnd = new Date(
      toUtc.getTime() + (24 * 60 - tzOffsetMinutes(toUtc, "Europe/Berlin")) * 60_000,
    );

    const leads = await getDialerLeadTouches(periodStart, asOfEnd);
    return NextResponse.json({ department, from: fromISO, to: toISO, leads });
  } catch (err) {
    console.error("[tracking/dialer-leads] failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal error" },
      { status: 500 },
    );
  }
}
