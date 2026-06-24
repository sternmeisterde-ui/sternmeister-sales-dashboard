import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { computeOverview } from "@/lib/funnel/overview";
import { parseLangBucket } from "@/lib/funnel/compute";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (session.role !== "admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const params = req.nextUrl.searchParams;
  const from = parseDate(params.get("from"));
  const to = parseDate(params.get("to"));
  if (!from || !to) {
    return NextResponse.json(
      { error: "from and to are required (YYYY-MM-DD)" },
      { status: 400 }
    );
  }
  const source = params.get("source") || null;
  const responsibleUserIdRaw = params.get("responsible_user_id");
  const responsibleUserId = responsibleUserIdRaw
    ? Number(responsibleUserIdRaw)
    : null;
  if (responsibleUserId !== null && Number.isNaN(responsibleUserId)) {
    return NextResponse.json(
      { error: "responsible_user_id must be a number" },
      { status: 400 }
    );
  }

  const lang = parseLangBucket(params.get("lang"));

  try {
    const payload = await computeOverview({
      from,
      to,
      maturity: "all", // зрелость к обзору не применяется
      source,
      responsibleUserId,
      lang,
    });
    return NextResponse.json(payload, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (e) {
    console.error("[/api/funnel/overview] compute failed:", e);
    return NextResponse.json(
      { error: "internal", message: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}

function parseDate(raw: string | null): Date | null {
  if (!raw) return null;
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(d.getTime()) ? null : d;
}
