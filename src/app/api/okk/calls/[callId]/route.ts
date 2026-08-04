import { NextRequest, NextResponse } from "next/server";
import { getOkkDbForDepartment } from "@/lib/db/okk";
import { getOkkVoiceDetail, getOkkFeedbackTask } from "@/lib/db/okk-feedback";
import { fetchOkkCallDetail } from "@/lib/eval/snapshot";

// ─── GET /api/okk/calls/[callId] ─────────────────────────────────────────────
// Query params:
//   dept  — "b2g" | "b2b"  (default: "b2g")
//
// Вся сборка детализации (blocks/meta/транскрипт/таймкоды) — в
// src/lib/eval/snapshot.ts (fetchOkkCallDetail): общий код с снапшотами
// вкладки «Жалобы». Здесь остаётся только «Разбор ОС» (b2g-механика).

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ callId: string }> },
) {
  try {
    const { callId } = await params;

    if (!callId) {
      return NextResponse.json(
        { success: false, error: "callId is required" },
        { status: 400 },
      );
    }

    const sp = request.nextUrl.searchParams;
    const deptParam = sp.get("dept") ?? "b2g";
    const department = (deptParam === "b2b" ? "b2b" : "b2g") as "b2g" | "b2b";

    const detail = await fetchOkkCallDetail(department, callId);
    if (!detail) {
      return NextResponse.json(
        { success: false, error: "Call not found" },
        { status: 404 },
      );
    }

    // ── Разбор ОС (голосовая работа над ошибками) — ТОЛЬКО b2g (D2). ──────────
    // Транскрипт + ответ AI + вердикт (worst_calls.response_adequate). null = нет.
    const db = getOkkDbForDepartment(department);
    const voiceFeedback =
      department === "b2g" ? await getOkkVoiceDetail(db, callId) : null;
    // Задача на разбор (что просили разобрать, что отправляли, как оценён
    // разбор). Только b2g — механика включена для Госников.
    const feedbackTask =
      department === "b2g" ? await getOkkFeedbackTask(db, callId) : null;

    return NextResponse.json({
      success: true,
      data: { ...detail, voiceFeedback, feedbackTask },
    });
  } catch (error) {
    console.error("[OKK Call Detail API] Error:", error);
    const message =
      error instanceof Error ? error.message : "Internal server error";
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 },
    );
  }
}
