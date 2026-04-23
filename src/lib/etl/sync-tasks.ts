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

  await analyticsDb.execute(
    sql.raw(`DELETE FROM analytics.tasks WHERE lead_id IN (${leadIds.join(",")})`),
  );

  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    await analyticsDb.insert(tasks).values(rows.slice(i, i + CHUNK));
  }

  console.log(`[ETL] sync-tasks: inserted ${rows.length} rows`);
  return rows.length;
}
