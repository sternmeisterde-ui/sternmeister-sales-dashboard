// Поллер присутствия менеджеров из CloudTalk (спека 26, Фаза 0).
//
// CloudTalk не хранит истории статусов — API отдаёт только «сейчас». Поэтому
// ленту интервалов строим сами: раз в минуту снимаем срез и склеиваем его с
// открытыми интервалами. Точность границ ±1 минута, для полоски дня хватает.
//
// Бэкфилла не существует и не появится: до первого запуска этого поллера
// данных нет ни у нас, ни у CloudTalk.

import { and, eq, inArray, isNull, isNotNull } from "drizzle-orm";
import { db as d1Db } from "@/lib/db";
import { masterManagers } from "@/lib/db/schema-existing";
import { trackingDb } from "@/lib/db/tracking-db";
import { cloudtalkStatusIntervals } from "@/lib/db/schema-tracking";
import { ensureTrackingSchema } from "./init";
import {
  fetchAgentPresence,
  IDLE_STATUS_NAMES,
  type AgentPresence,
} from "@/lib/telephony/cloudtalk-dashboard";

// Пока только Госники (решение 2026-07-28). Включение Коммерсов — добавить 'b2b'
// сюда: механизм от отдела не зависит, у b2b просто часть людей на CallGear и
// статусов у них не будет вовсе.
const STATUS_DEPARTMENTS = ["b2g"] as const;

// Если открытый интервал не подтверждался дольше этого — поллер лежал. Тогда
// закрываем интервал по last_seen_at (а не «сейчас») и начинаем новый с текущего
// момента: разрыв между ними честно отрисуется как «нет данных». Три пропущенных
// тика — достаточный запас, чтобы единичная сетевая ошибка не рвала интервал.
const STALE_GAP_MS = 5 * 60_000;

export interface StatusSyncResult {
  skipped?: string;
  agentsSeen: number;
  managersMatched: number;
  opened: number;
  closed: number;
  extended: number;
  changes: Array<{ manager: string; from: string | null; to: string }>;
}

/** Ключ состояния: смена подстатуса простоя — это тоже смена состояния. */
function stateKey(status: string, idleTypeId: number | null): string {
  return idleTypeId != null ? `${status}:${idleTypeId}` : status;
}

function describe(status: string, idleTypeId: number | null): string {
  if (status !== "idle") return status;
  const name = idleTypeId != null ? IDLE_STATUS_NAMES[idleTypeId] : null;
  return `idle(${name ?? idleTypeId ?? "?"})`;
}

export async function syncCloudTalkStatuses(): Promise<StatusSyncResult> {
  const empty: StatusSyncResult = {
    agentsSeen: 0, managersMatched: 0, opened: 0, closed: 0, extended: 0, changes: [],
  };

  if (process.env.CT_STATUS_SYNC_ENABLED !== "1") {
    return { ...empty, skipped: "CT_STATUS_SYNC_ENABLED != 1" };
  }

  await ensureTrackingSchema();

  // Ростер: активные менеджеры отделов из STATUS_DEPARTMENTS, у которых проставлен
  // cloudtalk_agent_id. Роли не фильтруем — присутствие интересно по всем, кто
  // вообще заведён в телефонии; лишние строки отсеются на чтении.
  const roster = await d1Db
    .select({
      id: masterManagers.id,
      name: masterManagers.name,
      department: masterManagers.department,
      cloudtalkAgentId: masterManagers.cloudtalkAgentId,
    })
    .from(masterManagers)
    .where(
      and(
        inArray(masterManagers.department, [...STATUS_DEPARTMENTS]),
        eq(masterManagers.isActive, true),
        isNotNull(masterManagers.cloudtalkAgentId),
      ),
    );

  if (roster.length === 0) {
    return { ...empty, skipped: "нет менеджеров с cloudtalk_agent_id" };
  }

  const byAgentId = new Map<number, (typeof roster)[number]>();
  for (const m of roster) {
    if (m.cloudtalkAgentId != null) byAgentId.set(Number(m.cloudtalkAgentId), m);
  }

  const presence: AgentPresence[] = await fetchAgentPresence();
  const now = new Date();

  // Открытые интервалы наших менеджеров.
  const managerIds = roster.map((m) => m.id);
  const openRows = await trackingDb
    .select()
    .from(cloudtalkStatusIntervals)
    .where(
      and(
        inArray(cloudtalkStatusIntervals.department, [...STATUS_DEPARTMENTS]),
        inArray(cloudtalkStatusIntervals.managerId, managerIds),
        isNull(cloudtalkStatusIntervals.endedAt),
      ),
    );
  // Теоретически на менеджера может оказаться несколько открытых (гонка двух
  // тиков) — берём свежайший, остальные закроем как хвосты.
  const openByManager = new Map<string, (typeof openRows)[number]>();
  const strayIds: number[] = [];
  for (const row of openRows.sort(
    (a, b) => b.startedAt.getTime() - a.startedAt.getTime(),
  )) {
    if (openByManager.has(row.managerId)) strayIds.push(row.id);
    else openByManager.set(row.managerId, row);
  }
  if (strayIds.length > 0) {
    await trackingDb
      .update(cloudtalkStatusIntervals)
      .set({ endedAt: now })
      .where(inArray(cloudtalkStatusIntervals.id, strayIds));
  }

  const result: StatusSyncResult = { ...empty, agentsSeen: presence.length };
  const toExtend: number[] = [];
  const toInsert: Array<typeof cloudtalkStatusIntervals.$inferInsert> = [];
  const seenManagers = new Set<string>();

  for (const agent of presence) {
    const manager = byAgentId.get(agent.agentId);
    if (!manager) continue; // чужой отдел / тех. учётка / не сматчен
    seenManagers.add(manager.id);
    result.managersMatched++;

    const open = openByManager.get(manager.id);
    const key = stateKey(agent.status, agent.idleTypeId);
    const openKey = open ? stateKey(open.status, open.idleTypeId) : null;
    const gapMs = open ? now.getTime() - open.lastSeenAt.getTime() : 0;
    const stale = open != null && gapMs > STALE_GAP_MS;

    if (open && openKey === key && !stale) {
      toExtend.push(open.id);
      result.extended++;
      continue;
    }

    if (open) {
      // Живой интервал закрываем текущим моментом; протухший — последним
      // подтверждением, чтобы не приписать человеку присутствие, которого мы
      // не наблюдали.
      await trackingDb
        .update(cloudtalkStatusIntervals)
        .set({ endedAt: stale ? open.lastSeenAt : now })
        .where(eq(cloudtalkStatusIntervals.id, open.id));
      result.closed++;
    }

    toInsert.push({
      department: manager.department,
      managerId: manager.id,
      cloudtalkAgentId: agent.agentId,
      status: agent.status,
      idleTypeId: agent.idleTypeId,
      idleName: agent.idleName,
      startedAt: now,
      lastSeenAt: now,
    });
    result.changes.push({
      manager: manager.name,
      from: open ? describe(open.status, open.idleTypeId) : null,
      to: describe(agent.status, agent.idleTypeId),
    });
  }

  // Менеджер пропал из среза (агента удалили в CloudTalk / сняли id) — закрываем
  // его открытый интервал последним подтверждением, а не «сейчас».
  const vanished = [...openByManager.values()].filter((r) => !seenManagers.has(r.managerId));
  for (const row of vanished) {
    await trackingDb
      .update(cloudtalkStatusIntervals)
      .set({ endedAt: row.lastSeenAt })
      .where(eq(cloudtalkStatusIntervals.id, row.id));
    result.closed++;
  }

  if (toExtend.length > 0) {
    await trackingDb
      .update(cloudtalkStatusIntervals)
      .set({ lastSeenAt: now })
      .where(inArray(cloudtalkStatusIntervals.id, toExtend));
  }
  if (toInsert.length > 0) {
    await trackingDb.insert(cloudtalkStatusIntervals).values(toInsert);
    result.opened += toInsert.length;
  }

  return result;
}
