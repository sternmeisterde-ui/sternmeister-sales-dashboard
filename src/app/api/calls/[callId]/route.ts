import { NextRequest, NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { getDbForDepartment } from "@/lib/db/index";
import { d1VoiceFeedback } from "@/lib/db/schema-existing";
import { fetchRoleplayCallDetail, type Department } from "@/lib/eval/snapshot";

// GET /api/calls/[callId]?department=b2g|b2b — детализация ролевки (D1/R1).
// Сборка blocks/summary — в src/lib/eval/snapshot.ts (fetchRoleplayCallDetail):
// общий код со снапшотами вкладки «Жалобы». Здесь остаётся только голосовой
// разбор (voiceFeedback, есть лишь у D1/b2g).

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ callId: string }> }
) {
  try {
    const { callId } = await params;
    const searchParams = request.nextUrl.searchParams;
    const department = (searchParams.get("department") as Department) || "b2g";

    if (!callId) {
      return NextResponse.json(
        { success: false, error: "callId is required" },
        { status: 400 }
      );
    }

    const detail = await fetchRoleplayCallDetail(department, callId);
    if (!detail) {
      return NextResponse.json(
        { success: false, error: "Call not found" },
        { status: 404 }
      );
    }

    // Голосовой разбор («работа над ошибками») — только D1/b2g, у R1 таблицы нет.
    // Берём самый свежий, если менеджер записывал несколько.
    let voiceFeedback: {
      adequate: boolean | null;
      transcript: string;
      aiResponse: string;
      durationSeconds: number | null;
      createdAt: string | null;
      voiceFileId: string | null;
    } | null = null;
    if (department === "b2g") {
      const db = getDbForDepartment(department);
      const fbRows = await db
        .select({
          adequate: d1VoiceFeedback.adequate,
          transcript: d1VoiceFeedback.transcript,
          aiResponse: d1VoiceFeedback.aiResponse,
          durationSeconds: d1VoiceFeedback.durationSeconds,
          createdAt: d1VoiceFeedback.createdAt,
          voiceFileId: d1VoiceFeedback.voiceFileId,
        })
        .from(d1VoiceFeedback)
        .where(eq(d1VoiceFeedback.callId, callId))
        .orderBy(desc(d1VoiceFeedback.createdAt))
        .limit(1);
      if (fbRows.length > 0) {
        const fb = fbRows[0];
        voiceFeedback = {
          adequate: fb.adequate,
          transcript: fb.transcript || "",
          aiResponse: fb.aiResponse || "",
          durationSeconds: fb.durationSeconds,
          createdAt: fb.createdAt ? new Date(fb.createdAt).toISOString() : null,
          voiceFileId: fb.voiceFileId ?? null,
        };
      }
    }

    return NextResponse.json({
      success: true,
      data: { ...detail, voiceFeedback },
    });
  } catch (error) {
    console.error("Error fetching call by id:", error);
    return NextResponse.json(
      { success: false, error: "Failed to fetch call" },
      { status: 500 }
    );
  }
}
