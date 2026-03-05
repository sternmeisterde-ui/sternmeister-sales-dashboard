import { eq, and, desc } from "drizzle-orm";
import { getDbForDepartment } from "./index";
import { d1Calls, d1Users, r1Calls, r1Users } from "./schema-existing";

// Тип отдела
export type DepartmentType = "b2g" | "b2b";

// Получить таблицы по типу отдела
// D1 таблицы → Госники (B2G) на ветке D1, R1 таблицы → Коммерсы (B2B) на ветке R1
function getTables(departmentType: DepartmentType) {
  return departmentType === "b2g"
    ? { calls: d1Calls, users: d1Users }   // Госники используют D1
    : { calls: r1Calls, users: r1Users };   // Коммерсы используют R1
}

// Получить все AI ролевые звонки для отдела
export async function getAIRoleCalls(departmentType: DepartmentType) {
  const { calls, users } = getTables(departmentType);
  const db = getDbForDepartment(departmentType);

  const result = await db
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
    .orderBy(desc(calls.startedAt));

  // Преобразовать в формат для фронтенда
  return result.map((call) => {
    const duration = call.durationSeconds || 0;
    const minutes = Math.floor(duration / 60);
    const seconds = duration % 60;

    // Parse evaluation blocks from evaluationJson (same logic as OKK route.ts)
    const blocks = (call.evaluationJson?.blocks || [])
      .filter((b) => (b.criteria && b.criteria.length > 0))
      .map((b, i) => ({
        id: String(i),
        name: b.name || "",
        score: b.block_score ?? 0,
        maxScore: b.max_block_score ?? 0,
        criteria: b.criteria
          ? b.criteria.map((c: any, idx: number) => ({
              id: idx + 1,
              name: c.name || "",
              score: typeof c.score === "number" ? c.score : c.score === "1" ? 1 : c.score === "0" ? 0 : -1,
              maxScore: typeof c.max_score === "number" ? c.max_score : c.max_score === 1 ? 1 : 0,
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

    return {
      id: call.id,
      name: call.userName || "Unknown",
      avatarUrl: `https://i.pravatar.cc/150?u=${call.userTelegramUsername || call.userId}`,
      callDuration: `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`,
      date: formatDate(call.startedAt),
      score: call.score || 0,
      hasRecording: !!call.recordingPath,
      audioUrl: call.recordingPath ? `/api/audio/${call.id}?dept=${departmentType}` : "#",
      kommoUrl: "#",
      transcript: call.transcript || "",
      aiFeedback: call.recommendations || "",
      summary: call.mistakes || "",
      blocks,
    };
  });
}

// Получить статистику менеджеров (2 запроса вместо N+1)
export async function getManagerStats(departmentType: DepartmentType) {
  const { calls, users } = getTables(departmentType);
  const db = getDbForDepartment(departmentType);

  // Параллельно: все пользователи + все звонки (2 запроса вместо N+1)
  const [allUsers, allCalls] = await Promise.all([
    db.select({
      id: users.id,
      name: users.name,
      telegramUsername: users.telegramUsername,
      role: users.role,
    }).from(users).where(and(eq(users.isActive, true), eq(users.role, "manager"))),

    db.select({
      userId: calls.userId,
      duration: calls.durationSeconds,
      score: calls.score,
    }).from(calls),
  ]);

  // Группировка звонков по userId в JS
  const callsByUser = new Map<string, typeof allCalls>();
  for (const call of allCalls) {
    const existing = callsByUser.get(call.userId) || [];
    existing.push(call);
    callsByUser.set(call.userId, existing);
  }

  return allUsers.map(user => {
    const userCalls = callsByUser.get(user.id) || [];
    const totalCalls = userCalls.length;
    const avgScore = totalCalls > 0
      ? Math.round(
          userCalls.reduce((acc, c) => acc + (c.score || 0), 0) / totalCalls
        )
      : 0;
    const avgDuration = totalCalls > 0
      ? Math.round(userCalls.reduce((acc, c) => acc + (c.duration || 0), 0) / totalCalls)
      : 0;

    const minutes = Math.floor(avgDuration / 60);
    const seconds = avgDuration % 60;
    const avgDurationFormatted = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;

    return {
      id: user.id,
      name: user.name,
      avatarUrl: `https://i.pravatar.cc/150?u=${user.telegramUsername || user.id}`,
      totalCalls,
      avgScore,
      avgDuration: avgDurationFormatted,
      conversionRate: "N/A",
      role: user.role,
    };
  });
}

// Вспомогательная функция для форматирования даты (Moscow timezone)
function formatDate(date: Date): string {
  const tz = "Europe/Moscow";
  const callDate = new Date(date);
  const now = new Date();

  // Получаем дату в московском часовом поясе для сравнения "сегодня/вчера"
  const nowMsk = now.toLocaleDateString("en-CA", { timeZone: tz }); // "YYYY-MM-DD"
  const callMsk = callDate.toLocaleDateString("en-CA", { timeZone: tz });

  const hours = callDate.toLocaleString("ru-RU", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false });

  if (callMsk === nowMsk) {
    return `Сегодня, ${hours}`;
  }

  // Вчера
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayMsk = yesterday.toLocaleDateString("en-CA", { timeZone: tz });
  if (callMsk === yesterdayMsk) {
    return `Вчера, ${hours}`;
  }

  const day = callDate.toLocaleString("ru-RU", { timeZone: tz, day: "2-digit" });
  const month = callDate.toLocaleString("ru-RU", { timeZone: tz, month: "2-digit" });
  return `${day}.${month}, ${hours}`;
}

