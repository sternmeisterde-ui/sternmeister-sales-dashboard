import { eq, and, desc, gte, lte, sql, inArray } from "drizzle-orm";
import { getDbForDepartment } from "./index";
import { d1Calls, d1Users, r1Calls, r1Users } from "./schema-existing";
import { formatCallDate, parseDateBoundary } from "@/lib/utils/date";

// Тип отдела
export type DepartmentType = "b2g" | "b2b";

// Bug #11: minimum call duration thresholds for roleplay tables
// R1 (commercial): 300 s (5 min), D1 (qualifier: 600 s, berater/dovedenie: 300 s)
// Use the lowest per-department floor so very short calls (hung up, test calls) never appear.
const MIN_DURATION_ROLEPLAY: Record<DepartmentType, number> = {
  b2b: 300, // R1 — 5 min minimum
  b2g: 300, // D1 — 5 min minimum (qualifier is 10 min, but berater/dovedenie is 5 min)
};

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
    const fromUtc = parseDateBoundary(fromDate, "start");
    if (fromUtc) conditions.push(gte(calls.startedAt, fromUtc));
  }
  if (toDate) {
    const toUtc = parseDateBoundary(toDate, "end");
    if (toUtc) conditions.push(lte(calls.startedAt, toUtc));
  }

  // Only show calls that have been evaluated (have a score)
  conditions.push(gte(calls.durationSeconds, MIN_DURATION_ROLEPLAY[departmentType]));
  conditions.push(sql`${calls.score} IS NOT NULL`);

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
      date: formatCallDate(call.startedAt),
      // Raw ISO so clients can filter without round-tripping the display string.
      startedAtIso: call.startedAt ? new Date(call.startedAt).toISOString() : null,
      score: call.score || 0,
      hasRecording: !!call.recordingPath,
      audioUrl: call.recordingPath ? `/api/audio/${call.id}?dept=${departmentType}` : "#",
      kommoUrl: "#",
      // Heavy fields empty — loaded on-demand via /api/calls/[callId]
      transcript: "",
      aiFeedback: "",
      summary: "",
      evalSummary: "",
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
    }).from(users).where(and(eq(users.isActive, true), inArray(users.role, ["manager", "teamlead"]))),

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

