// Бэкфилл задач Kommo → analytics.tasks по окну updated_at.
//
// Зачем: syncTasks гоняется только при полном бэкфилле лидов и таблица задач
// отстаёт; этот скрипт добирает задачи напрямую через /api/v4/tasks с
// фильтром по updated_at (created_at ⊆ updated_at, завершения тоже бампают
// updated_at — окно ловит и новые, и закрытые, и перенесённые задачи).
//
// Запуск из корня репо (нужен .env.local c DATABASE_URL/ANALYTICS_DATABASE_URL
// и Kommo-токеном):
//   npx tsx scripts/backfill-tasks.ts                 # последние 7 дней
//   npx tsx scripts/backfill-tasks.ts --days 40
//   npx tsx scripts/backfill-tasks.ts --from 2026-05-29 --to 2026-07-07
//
// Аккуратность к Kommo: СВОЙ троттлинг ≤ 1 запрос/сек (жёстче общего лимитера
// клиента) — скрипт можно запускать рядом с работающим прод-кроном.
// Запись: upsert по task_id (unique, миграция 0015), БЕЗ DELETE — идемпотентно;
// completed_at write-once (см. sync-tasks.ts): первое увиденное значение
// фиксируется, правки закрытых задач не переносят «Завершено» на другой день.

import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { getAuthHeaders, getBaseUrl, getUsers } from "../src/lib/kommo/client";
import { analyticsDb } from "../src/lib/db/analytics";
import { tasks } from "../src/lib/db/schema-analytics";
import { sql } from "drizzle-orm";

const RATE_MS = 1100; // ≤1 rps, с запасом
let lastRequestAt = 0;
async function politeFetch(url: string, headers: HeadersInit): Promise<Response> {
  // Ретраи: на длинных прогонах Kommo/прокси иногда рвёт keep-alive
  // («other side closed») — это транзиент, повторяем с паузой. Пауза
  // ретрая длиннее RATE_MS, так что 1 rps не нарушается.
  for (let attempt = 1; ; attempt++) {
    const wait = lastRequestAt + RATE_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastRequestAt = Date.now();
    try {
      const res = await fetch(url, { headers });
      if (res.status >= 500 && attempt < 4) {
        console.warn(`  HTTP ${res.status}, ретрай ${attempt}/3 через 3с…`);
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
      return res;
    } catch (e) {
      if (attempt >= 4) throw e;
      console.warn(`  сеть: ${e instanceof Error ? e.message : e}, ретрай ${attempt}/3 через 3с…`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

function arg(name: string, def: string | null = null): string | null {
  const args = process.argv.slice(2);
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : def;
}

interface RawTask {
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

async function main() {
  const days = Number(arg("days", "7"));
  const toStr = arg("to");
  const fromStr = arg("from");
  const to = toStr ? new Date(`${toStr}T23:59:59Z`) : new Date();
  const from = fromStr
    ? new Date(`${fromStr}T00:00:00Z`)
    : new Date(to.getTime() - days * 86_400_000);
  console.log(`[backfill-tasks] окно updated_at: ${from.toISOString()} … ${to.toISOString()}`);

  const started = Date.now();
  let requests = 0;

  // Имена ответственных (1 запрос)
  const users = await getUsers();
  requests++;
  const nameByUser = new Map(users.map((u) => [u.id, u.name]));

  // Постранично тянем задачи по лидам в окне updated_at
  const baseUrl = await getBaseUrl();
  const headers = await getAuthHeaders();
  const raw: RawTask[] = [];
  for (let page = 1; ; page++) {
    const url = new URL(`${baseUrl}/tasks`);
    url.searchParams.set("limit", "250");
    url.searchParams.set("page", String(page));
    url.searchParams.set("filter[entity_type]", "leads");
    url.searchParams.set("filter[updated_at][from]", String(Math.floor(from.getTime() / 1000)));
    url.searchParams.set("filter[updated_at][to]", String(Math.floor(to.getTime() / 1000)));
    const res = await politeFetch(url.toString(), headers);
    requests++;
    if (res.status === 204) break;
    if (!res.ok) throw new Error(`Kommo /tasks page ${page}: HTTP ${res.status}`);
    const data = (await res.json()) as { _embedded?: { tasks?: RawTask[] } };
    const batch = data._embedded?.tasks ?? [];
    raw.push(...batch);
    console.log(`  страница ${page}: +${batch.length} (всего ${raw.length})`);
    if (batch.length < 250) break;
  }
  if (raw.length === 0) {
    console.log("[backfill-tasks] задач в окне нет — выходим.");
    return;
  }

  // Лид-поля из нашего зеркала (без походов в Kommo)
  const leadIds = [...new Set(raw.map((t) => t.entity_id))];
  const leadInfo = new Map<number, { createdAt: Date | null; manager: string | null; closed: number }>();
  const CHUNK_DB = 5000;
  for (let i = 0; i < leadIds.length; i += CHUNK_DB) {
    const res = await analyticsDb.execute<{
      lead_id: string;
      created_at: string | null;
      manager: string | null;
      status_id: string | null;
    }>(
      sql.raw(
        `SELECT lead_id, to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at, manager, status_id
         FROM analytics.leads_cohort WHERE lead_id IN (${leadIds.slice(i, i + CHUNK_DB).join(",")})`,
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

  // completed_at write-once: существующие значения не перетираем
  const existingCompleted = new Map<number, Date>();
  const taskIds = raw.map((t) => t.id);
  for (let i = 0; i < taskIds.length; i += CHUNK_DB) {
    const res = await analyticsDb.execute<{ task_id: string; completed_at: string }>(
      sql.raw(
        `SELECT task_id, to_char(completed_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS completed_at
         FROM analytics.tasks
         WHERE task_id IN (${taskIds.slice(i, i + CHUNK_DB).join(",")}) AND completed_at IS NOT NULL`,
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
    console.log(`  upsert ${Math.min(i + CHUNK, rows.length)}/${rows.length}`);
  }

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(
    `[backfill-tasks] готово: ${rows.length} задач (${leadIds.length} лидов), ` +
      `${requests} запросов к Kommo за ${secs}с`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
