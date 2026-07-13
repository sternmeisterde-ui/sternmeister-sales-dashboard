import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDocflowStats } from "@/lib/docflow/stats";
import { parseVertical } from "@/lib/kommo/pipeline-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * GET /api/docflow?from=YYYY-MM-DD&to=YYYY-MM-DD
 * Статистика сервиса BGS DocFlow (автоматизация откликов на вакансии
 * учеников, B2G). Только admin. from/to фильтруют отклики по sent_at
 * (берлинская гражд. дата); роспись клиентов (всего/в работе/завершили) —
 * снимок по всему времени, периодом не режется.
 * Нет DOCFLOW_DATABASE_URL / БД недоступна → available:false (graceful).
 */
export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (session.role !== "admin") return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const sp = req.nextUrl.searchParams;
  const from = sp.get("from");
  const to = sp.get("to");
  if (!from || !to || !DATE_RE.test(from) || !DATE_RE.test(to)) {
    return NextResponse.json({ error: "bad range" }, { status: 400 });
  }
  const vertical = parseVertical(sp.get("vertical"));

  try {
    const stats = await getDocflowStats({ from, to, vertical });
    return NextResponse.json(stats, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[/api/docflow] failed:", e);
    return NextResponse.json(
      { error: "internal", message: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
