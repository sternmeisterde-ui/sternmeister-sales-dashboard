import { eq, desc, and } from "drizzle-orm";
import { dbD1, dbR1 } from "./index";
import { aiRoleCalls, users, departments } from "./schema";

// Тип отдела
export type DepartmentType = "b2g" | "b2b";

// Получить базу данных по типу отдела
function getDb(departmentType: DepartmentType) {
  return departmentType === "b2g" ? dbD1 : dbR1;
}

// Получить все AI ролевые звонки для отдела
export async function getAIRoleCalls(departmentType: DepartmentType) {
  const db = getDb(departmentType);

  const calls = await db
    .select({
      id: aiRoleCalls.id,
      userId: aiRoleCalls.userId,
      callDuration: aiRoleCalls.callDuration,
      callDate: aiRoleCalls.callDate,
      audioUrl: aiRoleCalls.audioUrl,
      transcript: aiRoleCalls.transcript,
      aiSummary: aiRoleCalls.aiSummary,
      aiFeedback: aiRoleCalls.aiFeedback,
      aiScore: aiRoleCalls.aiScore,
      scoringBlocks: aiRoleCalls.scoringBlocks,
      userName: users.name,
      userAvatar: users.avatarUrl,
    })
    .from(aiRoleCalls)
    .leftJoin(users, eq(aiRoleCalls.userId, users.id))
    .orderBy(desc(aiRoleCalls.callDate));

  return calls;
}

// Получить звонки по конкретному менеджеру
export async function getAIRoleCallsByUser(
  departmentType: DepartmentType,
  userId: number
) {
  const db = getDb(departmentType);

  const calls = await db
    .select()
    .from(aiRoleCalls)
    .where(eq(aiRoleCalls.userId, userId))
    .orderBy(desc(aiRoleCalls.callDate));

  return calls;
}

// Получить статистику менеджеров
export async function getManagerStats(departmentType: DepartmentType) {
  const db = getDb(departmentType);

  const managers = await db
    .select({
      id: users.id,
      name: users.name,
      avatarUrl: users.avatarUrl,
      email: users.email,
    })
    .from(users)
    .leftJoin(departments, eq(users.departmentId, departments.id))
    .where(
      eq(departments.type, departmentType)
    );

  // Получить статистику для каждого менеджера
  const stats = await Promise.all(
    managers.map(async (manager) => {
      const calls = await db
        .select({
          duration: aiRoleCalls.callDuration,
          score: aiRoleCalls.aiScore,
        })
        .from(aiRoleCalls)
        .where(eq(aiRoleCalls.userId, manager.id));

      const totalCalls = calls.length;
      const avgScore = calls.length > 0
        ? Math.round(calls.reduce((acc, c) => acc + (c.score || 0), 0) / calls.length)
        : 0;
      const avgDuration = calls.length > 0
        ? Math.round(calls.reduce((acc, c) => acc + c.duration, 0) / calls.length)
        : 0;

      // Форматировать среднюю длительность в MM:SS
      const minutes = Math.floor(avgDuration / 60);
      const seconds = avgDuration % 60;
      const avgDurationFormatted = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;

      return {
        id: manager.id.toString(),
        name: manager.name,
        avatarUrl: manager.avatarUrl || `https://i.pravatar.cc/150?u=${manager.email}`,
        totalCalls,
        avgScore,
        avgDuration: avgDurationFormatted,
        conversionRate: "N/A", // Можно добавить расчет конверсии позже
      };
    })
  );

  return stats;
}

// Получить один звонок по ID
export async function getAIRoleCallById(
  departmentType: DepartmentType,
  callId: number
) {
  const db = getDb(departmentType);

  const call = await db
    .select({
      id: aiRoleCalls.id,
      userId: aiRoleCalls.userId,
      callDuration: aiRoleCalls.callDuration,
      callDate: aiRoleCalls.callDate,
      audioUrl: aiRoleCalls.audioUrl,
      transcript: aiRoleCalls.transcript,
      aiSummary: aiRoleCalls.aiSummary,
      aiFeedback: aiRoleCalls.aiFeedback,
      aiScore: aiRoleCalls.aiScore,
      scoringBlocks: aiRoleCalls.scoringBlocks,
      userName: users.name,
      userAvatar: users.avatarUrl,
    })
    .from(aiRoleCalls)
    .leftJoin(users, eq(aiRoleCalls.userId, users.id))
    .where(eq(aiRoleCalls.id, callId))
    .limit(1);

  return call[0] || null;
}
