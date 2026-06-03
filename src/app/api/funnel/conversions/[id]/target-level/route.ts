import { NextRequest, NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { getSession } from "@/lib/auth";
import { analyticsDb } from "@/lib/db/analytics";
import { CONVERSION_ORDER } from "@/lib/funnel/conversions";
import type { ConversionId } from "@/lib/funnel/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Body {
  conversion_pct?: number | null;
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (session.role !== "admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { id: idRaw } = await params;
  if (!CONVERSION_ORDER.includes(idRaw as ConversionId)) {
    return NextResponse.json(
      { error: `unknown conversion ${idRaw}` },
      { status: 400 }
    );
  }
  const conversionId = idRaw as ConversionId;

  let body: Body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const raw = body.conversion_pct;
  let conversionPct: number | null;
  if (raw === null || raw === undefined) {
    conversionPct = null;
  } else if (typeof raw !== "number" || Number.isNaN(raw)) {
    return NextResponse.json(
      { error: "conversion_pct must be a number 0..100 or null" },
      { status: 422 }
    );
  } else if (raw < 0 || raw > 100) {
    return NextResponse.json(
      { error: "conversion_pct must be in [0, 100]" },
      { status: 422 }
    );
  } else {
    conversionPct = Math.round(raw * 100) / 100; // 2 знака после запятой
  }

  try {
    await analyticsDb.execute(sql`
      INSERT INTO analytics.funnel_target_levels
        (conversion_id, conversion_pct, updated_at, updated_by)
      VALUES
        (${conversionId}, ${conversionPct}, NOW(), ${session.name ?? session.telegramUsername ?? null})
      ON CONFLICT (conversion_id) DO UPDATE SET
        conversion_pct = EXCLUDED.conversion_pct,
        updated_at     = NOW(),
        updated_by     = EXCLUDED.updated_by
    `);
    return NextResponse.json(
      { conversion_id: conversionId, conversion_pct: conversionPct },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (e) {
    console.error("[/api/funnel/conversions/:id/target-level] PATCH failed:", e);
    return NextResponse.json(
      { error: "internal", message: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}
