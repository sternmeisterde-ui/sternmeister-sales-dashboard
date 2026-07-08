// ETL: sync tasks from Kommo API → analytics.tasks

import { getLeadTasks, getUsers, getAuthHeaders, getBaseUrl, rateLimitedFetch } from "@/lib/kommo/client";
import { analyticsDb } from "@/lib/db/analytics";
import { tasks } from "@/lib/db/schema-analytics";
import { sql } from "drizzle-orm";
import type { LeadCacheEntry } from "./sync-leads";
import type { KommoLookups } from "./lookups";

export async function syncTasks(
  leadCache: LeadCacheEntry[],
  lookups: KommoLookups,
): Promise<number> {
  if (leadCache.length === 0) return 0;

  const leadIds = leadCache.map((e) => e.leadId);
  const leadMap = new Map(leadCache.map((e) => [e.leadId, e]));

  const rawTasks = await getLeadTasks(leadIds);
  console.log(`[ETL] sync-tasks: ${rawTasks.length} tasks for ${leadIds.length} leads`);
  if (rawTasks.length === 0) return 0;

  // Write-once для completed_at: значение аппроксимируется updated_at Kommo
  // (см. ниже), а updated_at бампается любой правкой уже закрытой задачи —
  // без фиксации «дата завершения» дрейфовала бы между ресинками (DELETE
  // ниже стирает строку, ON CONFLICT не спасает). Паттерн тот же, что у
  // termin_date_first в sync-leads: читаем существующие значения и
  // сохраняем первое увиденное.
  const existingCompleted = new Map<number, Date>();
  const EXIST_CHUNK = 10_000;
  for (let i = 0; i < leadIds.length; i += EXIST_CHUNK) {
    const res = await analyticsDb.execute<{ task_id: string; completed_at: string }>(
      sql.raw(
        `SELECT task_id, completed_at FROM analytics.tasks
         WHERE lead_id IN (${leadIds.slice(i, i + EXIST_CHUNK).join(",")})
           AND completed_at IS NOT NULL`,
      ),
    );
    for (const r of res.rows) {
      existingCompleted.set(Number(r.task_id), new Date(String(r.completed_at).replace(" ", "T") + "Z"));
    }
  }

  type TaskRow = typeof tasks.$inferInsert;
  const rows: TaskRow[] = [];

  for (const t of rawTasks) {
    if (t.entityType !== "leads") continue;
    const lead = leadMap.get(t.entityId);
    const pipeline = lead ? lookups.pipelines.get(lead.pipelineId) : undefined;
    const status = pipeline?.statuses.get(lead?.statusId ?? 0);
    const closedFlg = status && (status.type === 1 || status.type === 2) ? 1 : 0;

    rows.push({
      taskId: t.id,
      leadId: t.entityId,
      leadCreatedAt: lead?.createdAt ?? null,
      closedFlg,
      leadManager: lead?.manager ?? null,
      taskCreatedAt: new Date(t.createdAt * 1000),
      // Kommo /api/v4/tasks НЕ отдаёт момент завершения отдельным полем:
      // result = {text} без created_at, поэтому старый маппинг
      // t.result?.createdAt всегда давал NULL (все 68k строк были без
      // completed_at). Для завершённой задачи берём updated_at — последнее
      // изменение закрытой задачи ≈ момент её закрытия, — но фиксируем
      // ПЕРВОЕ увиденное значение (existingCompleted), чтобы последующие
      // правки закрытой задачи не переносили её «Завершено» на другой день.
      // Переоткрытая задача (isCompleted=false) сбрасывается в NULL.
      // Нужен вкладке «Регламент» (Задачи: «Завершено» по дням).
      completedAt: !t.isCompleted
        ? null
        : (existingCompleted.get(t.id) ??
          (t.result?.createdAt ? new Date(t.result.createdAt * 1000) : new Date(t.updatedAt * 1000))),
      isCompleted: t.isCompleted ? 1 : 0,
      deadline: t.completeTill ? new Date(t.completeTill * 1000) : null,
      taskManager: lookups.users.get(t.responsibleUserId) ?? null,
    });
  }

  // DELETE-by-leadId clears tasks that were deleted in Kommo so they don't
  // linger as orphans in our analytics copy. The follow-up INSERT … ON
  // CONFLICT then writes the current state. The DELETE is safe here
  // because:
  //   - syncTasks runs only on full backfills (cron skips it in incremental
  //     mode), so a brief empty window between DELETE and INSERT is
  //     acceptable — next backfill will repopulate.
  //   - The INSERT is now idempotent: a chunk retry after a successful
  //     server-side commit (Neon HTTP retry hazard) becomes a no-op UPDATE
  //     instead of a duplicate row, thanks to the unique index on task_id
  //     (migration 0015) — see docs/etl-architecture.md.
  //
  // Mutable fields (deadline, manager reassignment, completion state) are
  // refreshed on conflict so a re-sync picks up updates.
  await analyticsDb.execute(
    sql.raw(`DELETE FROM analytics.tasks WHERE lead_id IN (${leadIds.join(",")})`),
  );

  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    await analyticsDb
      .insert(tasks)
      .values(rows.slice(i, i + CHUNK))
      .onConflictDoUpdate({
        target: tasks.taskId,
        set: {
          leadId: sql`EXCLUDED.lead_id`,
          leadCreatedAt: sql`EXCLUDED.lead_created_at`,
          closedFlg: sql`EXCLUDED.closed_flg`,
          leadManager: sql`EXCLUDED.lead_manager`,
          taskCreatedAt: sql`EXCLUDED.task_created_at`,
          completedAt: sql`EXCLUDED.completed_at`,
          isCompleted: sql`EXCLUDED.is_completed`,
          deadline: sql`EXCLUDED.deadline`,
          taskManager: sql`EXCLUDED.task_manager`,
        },
      });
  }

  console.log(`[ETL] sync-tasks: inserted ${rows.length} rows`);
  return rows.length;
}

// ─── Инкрементальный синк задач (для 10-мин крона) ──────────────────
//
// Тяжёлый syncTasks выше тянет ВСЕ открытые задачи по лидам и потому
// в инкрементальном режиме раньше просто пропускался — analytics.tasks
// протухала (последний раз это кончилось дырой 29.05–07.07 и бэкфиллом).
// Этот шаг дешёвый: Kommo /tasks с filter[updated_at] по окну тика —
// создание, правка, перенос дедлайна и закрытие задачи бампают updated_at,
// так что окно ловит все изменения. Upsert по task_id (без DELETE),
// completed_at — write-once (см. комментарий в syncTasks).

interface RawIncrementalTask {
  id: number;
  entity_id: number;
  entity_type: string;
  created_at: number;
  updated_at: number;
  is_completed: boolean;
  complete_till: number;
  responsible_user_id: number;
  result?: { created_at?: number } | null;
}

export async function syncTasksIncremental(fromDate: Date, toDate: Date): Promise<number> {
  const baseUrl = await getBaseUrl();
  const headers = await getAuthHeaders();
  const raw: RawIncrementalTask[] = [];
  for (let page = 1; page <= 200; page++) {
    const url = new URL(`${baseUrl}/tasks`);
    url.searchParams.set("limit", "250");
    url.searchParams.set("page", String(page));
    url.searchParams.set("filter[entity_type]", "leads");
    url.searchParams.set("filter[updated_at][from]", String(Math.floor(fromDate.getTime() / 1000)));
    url.searchParams.set("filter[updated_at][to]", String(Math.floor(toDate.getTime() / 1000)));
    const res = await rateLimitedFetch(url.toString(), { headers });
    if (res.status === 204) break;
    if (!res.ok) throw new Error(`Kommo /tasks (incremental) page ${page}: HTTP ${res.status}`);
    const data = (await res.json()) as { _embedded?: { tasks?: RawIncrementalTask[] } };
    const batch = data._embedded?.tasks ?? [];
    raw.push(...batch);
    if (batch.length < 250) break;
  }
  if (raw.length === 0) {
    console.log("[ETL] sync-tasks-incremental: 0 tasks in window");
    return 0;
  }

  // Имена ответственных + лид-поля — из справочника Kommo и нашего зеркала.
  const users = await getUsers();
  const nameByUser = new Map(users.map((u) => [u.id, u.name]));
  const leadIds = [...new Set(raw.map((t) => t.entity_id))];
  const leadInfo = new Map<number, { createdAt: Date | null; manager: string | null; closed: number }>();
  const DB_CHUNK = 5000;
  for (let i = 0; i < leadIds.length; i += DB_CHUNK) {
    const res = await analyticsDb.execute<{
      lead_id: string;
      created_at: string | null;
      manager: string | null;
      status_id: string | null;
    }>(
      sql.raw(
        `SELECT lead_id, to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at, manager, status_id
         FROM analytics.leads_cohort WHERE lead_id IN (${leadIds.slice(i, i + DB_CHUNK).join(",")})`,
      ),
    );
    for (const r of res.rows) {
      leadInfo.set(Number(r.lead_id), {
        createdAt: r.created_at ? new Date(r.created_at) : null,
        manager: r.manager,
        closed: r.status_id != null && [142, 143].includes(Number(r.status_id)) ? 1 : 0,
      });
    }
  }

  // completed_at write-once
  const existingCompleted = new Map<number, Date>();
  const taskIds = raw.map((t) => t.id);
  for (let i = 0; i < taskIds.length; i += DB_CHUNK) {
    const res = await analyticsDb.execute<{ task_id: string; completed_at: string }>(
      sql.raw(
        `SELECT task_id, to_char(completed_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS completed_at
         FROM analytics.tasks
         WHERE task_id IN (${taskIds.slice(i, i + DB_CHUNK).join(",")}) AND completed_at IS NOT NULL`,
      ),
    );
    for (const r of res.rows) existingCompleted.set(Number(r.task_id), new Date(r.completed_at));
  }

  type TaskRow = typeof tasks.$inferInsert;
  const rows: TaskRow[] = raw.map((t) => {
    const lead = leadInfo.get(t.entity_id);
    return {
      taskId: t.id,
      leadId: t.entity_id,
      leadCreatedAt: lead?.createdAt ?? null,
      closedFlg: lead?.closed ?? 0,
      leadManager: lead?.manager ?? null,
      taskCreatedAt: new Date(t.created_at * 1000),
      completedAt: !t.is_completed
        ? null
        : (existingCompleted.get(t.id) ??
          (t.result?.created_at ? new Date(t.result.created_at * 1000) : new Date(t.updated_at * 1000))),
      isCompleted: t.is_completed ? 1 : 0,
      deadline: t.complete_till ? new Date(t.complete_till * 1000) : null,
      taskManager: nameByUser.get(t.responsible_user_id) ?? null,
    };
  });

  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    await analyticsDb
      .insert(tasks)
      .values(rows.slice(i, i + CHUNK))
      .onConflictDoUpdate({
        target: tasks.taskId,
        set: {
          leadId: sql`EXCLUDED.lead_id`,
          leadCreatedAt: sql`EXCLUDED.lead_created_at`,
          closedFlg: sql`EXCLUDED.closed_flg`,
          leadManager: sql`EXCLUDED.lead_manager`,
          taskCreatedAt: sql`EXCLUDED.task_created_at`,
          completedAt: sql`EXCLUDED.completed_at`,
          isCompleted: sql`EXCLUDED.is_completed`,
          deadline: sql`EXCLUDED.deadline`,
          taskManager: sql`EXCLUDED.task_manager`,
        },
      });
  }
  console.log(`[ETL] sync-tasks-incremental: upserted ${rows.length} rows`);
  return rows.length;
}
