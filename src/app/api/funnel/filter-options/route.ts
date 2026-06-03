import { NextRequest, NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { getSession } from "@/lib/auth";
import { analyticsDb } from "@/lib/db/analytics";
import { B2G_PIPELINES } from "@/lib/kommo/pipeline-config";
import { unwrapRows } from "@/lib/funnel/compute";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BUH_GOS = B2G_PIPELINES.FIRST_LINE;

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (session.role !== "admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const sp = req.nextUrl.searchParams;
  const from = parseDate(sp.get("from"));
  const to = parseDate(sp.get("to"));
  if (!from || !to) {
    return NextResponse.json(
      { error: "from and to are required (YYYY-MM-DD)" },
      { status: 400 }
    );
  }

  try {
    // Источники (UTM-каналы), реально присутствующие в выборке.
    const sourcesRows = await analyticsDb.execute(sql`
      SELECT DISTINCT utm_source AS "value"
      FROM analytics.leads_cohort
      WHERE pipeline_id = ${BUH_GOS}
        AND created_at >= ${from.toISOString()}
        AND created_at <  ${to.toISOString()}
        AND utm_source IS NOT NULL
        AND utm_source <> ''
      ORDER BY utm_source ASC
    `);
    const sources = unwrapRows<{ value: string }>(sourcesRows).map((r) => ({
      value: r.value,
      label: r.value,
    }));

    // Ответственные (manager + responsible_user_id).
    const managersRows = await analyticsDb.execute(sql`
      SELECT
        responsible_user_id AS "responsibleUserId",
        manager             AS "manager"
      FROM analytics.leads_cohort
      WHERE pipeline_id = ${BUH_GOS}
        AND created_at >= ${from.toISOString()}
        AND created_at <  ${to.toISOString()}
        AND responsible_user_id IS NOT NULL
      GROUP BY responsible_user_id, manager
    `);
    // Сводим к уникальным responsible_user_id (берём непустой manager как label,
    // fallback на «ID 12345»). Сортируем по label по алфавиту.
    const seen = new Map<string, { value: string; label: string }>();
    for (const r of unwrapRows<{
      responsibleUserId: string | number;
      manager: string | null;
    }>(managersRows)) {
      const id = String(r.responsibleUserId);
      const existing = seen.get(id);
      const label = r.manager?.trim() || `ID ${id}`;
      if (!existing || (existing.label.startsWith("ID ") && r.manager)) {
        seen.set(id, { value: id, label });
      }
    }
    const responsibleUsers = Array.from(seen.values()).sort((a, b) =>
      a.label.localeCompare(b.label, "ru")
    );

    return NextResponse.json(
      { sources, responsible_users: responsibleUsers },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (e) {
    console.error("[/api/funnel/filter-options] failed:", e);
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
  const d = new Date(
    Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  );
  return Number.isNaN(d.getTime()) ? null : d;
}
