// Применение решения по жалобе — общая логика для двух путей записи:
// PATCH /api/complaints/[id] (админ/РОП из вкладки) и
// POST /api/complaints/resolve (batch от Claude-адъюдикатора из OKK-репо).
//
// Семантика:
//  • переход в resolved/rejected проставляет resolved_at/resolved_by ОДИН раз
//    (повторное решение обновляет текст/вердикт, но не дату первого решения);
//  • оценка «после» замораживается ОДИН раз при первом переходе в
//    resolved/rejected (snapshotEval текущего состояния D2/R2 либо D1/R1);
//    повторный resolve её не пере-снимает — история фиксируется;
//  • откат статуса назад (in_review/new) снимков и дат не стирает.
//
// Порядок для OKK-стороны: сначала применить пересмотр оценки в своей БД,
// ПОТОМ звать resolve — иначе снимок «после» заморозит старое состояние.

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { complaints } from "@/lib/db/schema-existing";
import { snapshotEval, type Department } from "@/lib/eval/snapshot";

export const RESOLVE_STATUSES = new Set(["new", "in_review", "resolved", "rejected", "not_complaint"]);
export const RESOLVE_VERDICTS = new Set(["valid", "partial", "invalid"]);

export interface ResolutionInput {
  status: string;
  decision?: string | null;
  verdict?: string | null;
  resolvedBy: string;
}

export type ResolutionResult =
  | { ok: true; id: string; status: string }
  | { ok: false; error: string };

export async function applyResolution(
  complaintId: string,
  input: ResolutionInput,
): Promise<ResolutionResult> {
  if (!RESOLVE_STATUSES.has(input.status)) {
    return { ok: false, error: `bad status: ${input.status}` };
  }
  if (input.verdict != null && input.verdict !== "" && !RESOLVE_VERDICTS.has(input.verdict)) {
    return { ok: false, error: `bad verdict: ${input.verdict}` };
  }

  const rows = await db
    .select({
      id: complaints.id,
      department: complaints.department,
      callId: complaints.callId,
      callSource: complaints.callSource,
      resolvedAt: complaints.resolvedAt,
      evalAfter: complaints.evalAfter,
      scoreAfter: complaints.scoreAfter,
    })
    .from(complaints)
    .where(eq(complaints.id, complaintId))
    .limit(1);
  if (rows.length === 0) return { ok: false, error: "not found" };
  const row = rows[0];

  const isFinal = input.status === "resolved" || input.status === "rejected";

  const patch: Partial<typeof complaints.$inferInsert> = {
    status: input.status,
    updatedAt: new Date(),
  };
  if (input.decision !== undefined) patch.decision = input.decision || null;
  if (input.verdict !== undefined) patch.verdict = input.verdict || null;

  if (isFinal && !row.resolvedAt) {
    patch.resolvedAt = new Date();
    patch.resolvedBy = input.resolvedBy;
  }

  // Снимок «после» — один раз, best-effort: удалённый/изъятый звонок или
  // недоступность БД не блокируют решение (истина тогда в тексте decision).
  if (isFinal && row.callId && !row.evalAfter) {
    try {
      const snap = await snapshotEval({
        callSource: (row.callSource === "ai" ? "ai" : "okk"),
        callId: row.callId,
        department: row.department as Department,
      });
      if (snap) {
        patch.evalAfter = snap.payload as unknown as Record<string, unknown>;
        patch.scoreAfter = snap.score;
      }
    } catch (e) {
      console.error(`[complaints] snapshot after failed for ${complaintId}:`, e);
    }
  }

  await db.update(complaints).set(patch).where(eq(complaints.id, complaintId));
  return { ok: true, id: complaintId, status: input.status };
}
