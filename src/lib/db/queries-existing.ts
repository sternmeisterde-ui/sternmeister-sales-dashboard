import { eq, and, desc, gte, lte } from "drizzle-orm";
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
export async function getAIRoleCalls(departmentType: DepartmentType, fromDate?: string, toDate?: string) {
  const { calls, users } = getTables(departmentType);
  const db = getDbForDepartment(departmentType);

  const conditions: ReturnType<typeof eq>[] = [];
  if (fromDate) {
    conditions.push(gte(calls.startedAt, new Date(fromDate)));
  }
  if (toDate) {
    const end = new Date(toDate);
    end.setUTCHours(23, 59, 59, 999);
    conditions.push(lte(calls.startedAt, end));
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  // LIGHT query: no transcript, no evaluationJson heavy fields
  const result = await db
    .select({
      id: calls.id,
      userId: calls.userId,
      startedAt: calls.startedAt,
      durationSeconds: calls.durationSeconds,
      score: calls.score,
      recordingPath: calls.recordingPath,
      evaluationJson: calls.evaluationJson,
      userName: users.name,
      userTelegramUsername: users.telegramUsername,
    })
    .from(calls)
    .leftJoin(users, eq(calls.userId, users.id))
    .where(whereClause)
    .orderBy(desc(calls.startedAt))
    .limit(200);

  // Преобразовать в формат для фронтенда (LIGHT — без transcript/criteria)
  return result.map((call) => {
    const duration = call.durationSeconds || 0;
    const minutes = Math.floor(duration / 60);
    const seconds = duration % 60;

    // LIGHT blocks: only id/name/score/maxScore — criteria loaded on-demand via /api/calls/[callId]
    const blocks = (call.evaluationJson?.blocks || [])
      .filter((b) => (b.criteria && b.criteria.length > 0))
      .map((b, i) => ({
        id: String(i),
        name: b.name || "",
        score: b.block_score ?? 0,
        maxScore: b.max_block_score ?? 0,
        criteria: [] as any[],
        feedback: "",
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
      // Heavy fields empty — loaded on-demand via /api/calls/[callId]
      transcript: "",
      aiFeedback: "",
      summary: "",
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
      line: users.line,
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
      line: user.line || null,
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

