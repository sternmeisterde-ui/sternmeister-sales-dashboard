// POST /api/complaints/resolve — batch-приём итогов рассмотрения жалоб от
// Claude-адъюдикатора из OKK-репо (формат совместим с _adj/A*_result.json:
// массив объектов). Auth: Bearer COMPLAINTS_API_TOKEN (стиль CRON_SECRET,
// один вызыватель). Путь whitelist'ится в src/middleware.ts (иначе 307 в
// /login — класс бага d9079c6).
//
// Тело: массив элементов
//   {
//     complaint_id?: string;   // приоритетный таргет — id строки реестра
//     source_id?:    string;   // либо id строки evaluation_error_reports
//     call_id?:      string;   // либо звонок → самая свежая открытая жалоба
//     status: "resolved" | "rejected" | "in_review";
//     verdict?: "valid" | "partial" | "invalid";
//     decision: string;        // итог свободным текстом (summary + action)
//     resolved_by?: string;    // default "okk-adjudicator"
//   }
// Ответ всегда HTTP 200 с per-item результатами { target, ok, error? }.
//
// ВАЖНО (контракт для OKK-стороны): если по жалобе применяется пересмотр
// оценки — сначала применить его в D2/R2, ПОТОМ звать resolve: снимок
// «после» замораживается здесь один раз.

import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { complaints } from "@/lib/db/schema-existing";
import { applyResolution } from "@/lib/complaints/resolve";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function tokenOk(req: NextRequest): boolean {
  const expected = process.env.COMPLAINTS_API_TOKEN;
  if (!expected) return false; // env не задан → endpoint выключен
  const got = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!got) return false;
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

interface ResolveItem {
  complaint_id?: string;
  source_id?: string;
  call_id?: string;
  status?: string;
  verdict?: string;
  decision?: string;
  resolved_by?: string;
}

async function findComplaintId(item: ResolveItem): Promise<string | null> {
  if (item.complaint_id) return item.complaint_id;
  if (item.source_id) {
    const rows = await db
      .select({ id: complaints.id })
      .from(complaints)
      .where(and(eq(complaints.source, "error_report"), eq(complaints.sourceId, String(item.source_id))))
      .limit(1);
    return rows[0]?.id ?? null;
  }
  if (item.call_id) {
    // Самая свежая ещё не решённая жалоба по звонку; если все решены —
    // самая свежая вообще (повторный resolve обновит текст решения).
    const open = await db
      .select({ id: complaints.id })
      .from(complaints)
      .where(and(eq(complaints.callId, item.call_id), inArray(complaints.status, ["new", "in_review"])))
      .orderBy(desc(complaints.filedAt))
      .limit(1);
    if (open[0]) return open[0].id;
    const any = await db
      .select({ id: complaints.id })
      .from(complaints)
      .where(eq(complaints.callId, item.call_id))
      .orderBy(desc(complaints.filedAt))
      .limit(1);
    return any[0]?.id ?? null;
  }
  return null;
}

export async function POST(req: NextRequest) {
  if (!tokenOk(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let items: ResolveItem[];
  try {
    const body = await req.json();
    items = Array.isArray(body) ? body : [body];
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  if (items.length === 0 || items.length > 200) {
    return NextResponse.json({ error: "expected 1..200 items" }, { status: 400 });
  }

  const results: Array<{ target: string; ok: boolean; id?: string; error?: string }> = [];
  for (const item of items) {
    const target = item.complaint_id || item.source_id || item.call_id || "?";
    try {
      if (!item.status || !item.decision?.trim()) {
        results.push({ target, ok: false, error: "status and decision required" });
        continue;
      }
      const id = await findComplaintId(item);
      if (!id) {
        results.push({ target, ok: false, error: "complaint not found" });
        continue;
      }
      const res = await applyResolution(id, {
        status: item.status,
        decision: item.decision.trim(),
        verdict: item.verdict,
        resolvedBy: item.resolved_by || "okk-adjudicator",
      });
      if (res.ok) results.push({ target, ok: true, id: res.id });
      else results.push({ target, ok: false, error: res.error });
    } catch (e) {
      console.error(`[/api/complaints/resolve] item ${target} failed:`, e);
      results.push({ target, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return NextResponse.json({ results });
}
