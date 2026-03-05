import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDbForDepartment } from "@/lib/db/index";
import { d1Calls, d1Users, r1Calls, r1Users } from "@/lib/db/schema-existing";

// Тип отдела (повторяем локально, чтобы не зависеть от queries-existing)
type DepartmentType = "b2g" | "b2b";

// Выбор таблиц по отделу (D1 = Госники/B2G, R1 = Коммерсы/B2B)
function getTables(departmentType: DepartmentType) {
  return departmentType === "b2g"
    ? { calls: d1Calls, users: d1Users }
    : { calls: r1Calls, users: r1Users };
}

// Форматирование даты в московском часовом поясе
function formatDate(date: Date): string {
  const tz = "Europe/Moscow";
  const callDate = new Date(date);
  const now = new Date();
  const nowMsk = now.toLocaleDateString("en-CA", { timeZone: tz });
  const callMsk = callDate.toLocaleDateString("en-CA", { timeZone: tz });
  const hours = callDate.toLocaleString("ru-RU", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  if (callMsk === nowMsk) return `Сегодня, ${hours}`;
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayMsk = yesterday.toLocaleDateString("en-CA", { timeZone: tz });
  if (callMsk === yesterdayMsk) return `Вчера, ${hours}`;
  const day = callDate.toLocaleString("ru-RU", { timeZone: tz, day: "2-digit" });
  const month = callDate.toLocaleString("ru-RU", { timeZone: tz, month: "2-digit" });
  return `${day}.${month}, ${hours}`;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ callId: string }> }
) {
  try {
    const { callId } = await params;
    const searchParams = request.nextUrl.searchParams;
    const department = (searchParams.get("department") as DepartmentType) || "b2g";

    if (!callId) {
      return NextResponse.json(
        { success: false, error: "callId is required" },
        { status: 400 }
      );
    }

    const { calls, users } = getTables(department);
    const db = getDbForDepartment(department);

    const rows = await db
      .select({
        id: calls.id,
        userId: calls.userId,
        startedAt: calls.startedAt,
        endedAt: calls.endedAt,
        durationSeconds: calls.durationSeconds,
        transcript: calls.transcript,
        score: calls.score,
        mistakes: calls.mistakes,
        recommendations: calls.recommendations,
        recordingPath: calls.recordingPath,
        evaluationJson: calls.evaluationJson,
        userName: users.name,
        userTelegramUsername: users.telegramUsername,
      })
      .from(calls)
      .leftJoin(users, eq(calls.userId, users.id))
      .where(eq(calls.id, callId))
      .limit(1);

    if (rows.length === 0) {
      return NextResponse.json(
        { success: false, error: "Call not found" },
        { status: 404 }
      );
    }

    const call = rows[0];

    // Длительность звонка
    const duration = call.durationSeconds || 0;
    const minutes = Math.floor(duration / 60);
    const seconds = duration % 60;

    // Преобразование блоков оценки из evaluationJson
    const blocks = (call.evaluationJson?.blocks || [])
      .filter((b) => b.criteria && b.criteria.length > 0)
      .map((b, i) => ({
        id: String(i),
        name: b.name || "",
        score: b.block_score ?? 0,
        maxScore: b.max_block_score ?? 0,
        criteria: b.criteria
          ? b.criteria.map((c: any, idx: number) => ({
              id: idx + 1,
              name: c.name || "",
              score:
                typeof c.score === "number"
                  ? c.score
                  : c.score === "1"
                  ? 1
                  : c.score === "0"
                  ? 0
                  : -1,
              maxScore:
                typeof c.max_score === "number"
                  ? c.max_score
                  : c.max_score === 1
                  ? 1
                  : 0,
              feedback: c.feedback || "",
              quote: c.quote || "",
            }))
          : [],
        feedback: b.criteria
          ? b.criteria
              .filter((c: any) => c.score === 0 && c.max_score > 0)
              .map((c: any) => `❌ ${c.name}`)
              .join("\n")
          : "",
      }));

    const data = {
      id: call.id,
      name: call.userName || "Unknown",
      avatarUrl: `https://i.pravatar.cc/150?u=${call.userTelegramUsername || call.userId}`,
      callDuration: `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`,
      date: formatDate(call.startedAt),
      score: call.score || 0,
      hasRecording: !!call.recordingPath,
      audioUrl: call.recordingPath ? `/api/audio/${call.id}?dept=${department}` : "#",
      kommoUrl: "#",
      transcript: call.transcript || "",
      aiFeedback: call.recommendations || "",
      summary: call.mistakes || "",
      blocks,
    };

    return NextResponse.json({ success: true, data });
  } catch (error) {
    console.error("Error fetching call by id:", error);
    return NextResponse.json(
      { success: false, error: "Failed to fetch call" },
      { status: 500 }
    );
  }
}
