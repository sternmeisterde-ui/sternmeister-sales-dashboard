import { eq, desc } from "drizzle-orm";
import { db } from "./index";
import { d1Calls, d1Users, r1Calls, r1Users } from "./schema-existing";

// Тип отдела
export type DepartmentType = "b2g" | "b2b";

// Получить таблицы по типу отдела
// R1 таблицы → Коммерсы (B2B), D1 таблицы → Госники (B2G)
function getTables(departmentType: DepartmentType) {
  return departmentType === "b2g"
    ? { calls: r1Calls, users: r1Users }  // Коммерсы используют R1
    : { calls: d1Calls, users: d1Users };  // Госники используют D1
}

// Получить все AI ролевые звонки для отдела
export async function getAIRoleCalls(departmentType: DepartmentType) {
  const { calls, users } = getTables(departmentType);

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

    return {
      id: call.id,
      name: call.userName || "Unknown",
      avatarUrl: `https://i.pravatar.cc/150?u=${call.userTelegramUsername || call.userId}`,
      callDuration: `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`,
      date: formatDate(call.startedAt),
      score: call.score ? call.score * 10 : 0, // Конвертируем из 1-10 в 0-100 для UI
      audioUrl: "#", // TODO: добавить реальный URL аудио
      kommoUrl: "#",
      transcript: call.transcript || "",
      aiFeedback: call.recommendations || "",
      summary: call.mistakes || "",
      blocks: parseEvaluationJson(call.evaluationJson),
    };
  });
}

// Получить статистику менеджеров (2 запроса вместо N+1)
export async function getManagerStats(departmentType: DepartmentType) {
  const { calls, users } = getTables(departmentType);

  // Параллельно: все пользователи + все звонки (2 запроса вместо N+1)
  const [allUsers, allCalls] = await Promise.all([
    db.select({
      id: users.id,
      name: users.name,
      telegramUsername: users.telegramUsername,
      role: users.role,
    }).from(users).where(eq(users.isActive, true)),

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
          (userCalls.reduce((acc, c) => acc + (c.score || 0), 0) / totalCalls) * 10
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

// Вспомогательная функция для форматирования даты
function formatDate(date: Date): string {
  const now = new Date();
  const callDate = new Date(date);
  const diffMs = now.getTime() - callDate.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  const hours = callDate.getHours().toString().padStart(2, "0");
  const minutes = callDate.getMinutes().toString().padStart(2, "0");

  if (diffDays === 0) {
    return `Сегодня, ${hours}:${minutes}`;
  } else if (diffDays === 1) {
    return `Вчера, ${hours}:${minutes}`;
  } else {
    const day = callDate.getDate().toString().padStart(2, "0");
    const month = (callDate.getMonth() + 1).toString().padStart(2, "0");
    return `${day}.${month}, ${hours}:${minutes}`;
  }
}

// Парсинг evaluation_json в формат блоков для UI
function parseEvaluationJson(evaluationJson: any) {
  if (!evaluationJson || !evaluationJson.criteria) {
    return [];
  }

  return evaluationJson.criteria.map((criterion: any, index: number) => ({
    id: `block-${index}`,
    name: criterion.name || `Критерий ${index + 1}`,
    score: criterion.score || 0,
    maxScore: 10,
    feedback: criterion.feedback || "",
  }));
}
