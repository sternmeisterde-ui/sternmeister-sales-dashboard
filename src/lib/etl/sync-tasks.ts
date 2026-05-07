// ETL: sync tasks from Kommo API → analytics.tasks

import { getLeadTasks } from "@/lib/kommo/client";
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
      completedAt: t.result?.createdAt ? new Date(t.result.createdAt * 1000) : null,
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
