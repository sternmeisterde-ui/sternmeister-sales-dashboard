// Чтение ленты присутствия CloudTalk для отрисовки (спека 26, Фаза 1).
// Пишет её поллер cloudtalk-status-sync.ts; тут только читаем и нарезаем по дням.

import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { trackingDb } from "@/lib/db/tracking-db";
import { cloudtalkStatusIntervals } from "@/lib/db/schema-tracking";
import type { PresenceInterval } from "./timeline";

/** Отделы, по которым ведётся сбор. Синхронизировано с STATUS_DEPARTMENTS поллера. */
export function presenceEnabledFor(department: string): boolean {
  return department === "b2g";
}

export interface PresenceRange {
  managerId: string;
  status: PresenceInterval["status"];
  idleName: string | null;
  startMs: number;
  endMs: number;
}

/**
 * Все интервалы, пересекающие окно [fromMs, toMs), по указанным менеджерам.
 *
 * Конец открытого интервала — `last_seen_at`, а НЕ «сейчас»: открытый интервал
 * достоверен ровно до последнего подтверждения поллером. Если сервис лежал,
 * разрыв должен остаться разрывом («нет данных»), иначе полоска нарисует
 * присутствие, которого никто не наблюдал.
 */
export async function getPresenceRanges(
  department: string,
  managerIds: string[],
  fromMs: number,
  toMs: number,
): Promise<PresenceRange[]> {
  if (!presenceEnabledFor(department) || managerIds.length === 0) return [];

  const from = new Date(fromMs);
  const to = new Date(toMs);

  const rows = await trackingDb
    .select({
      managerId: cloudtalkStatusIntervals.managerId,
      status: cloudtalkStatusIntervals.status,
      idleName: cloudtalkStatusIntervals.idleName,
      startedAt: cloudtalkStatusIntervals.startedAt,
      endedAt: cloudtalkStatusIntervals.endedAt,
      lastSeenAt: cloudtalkStatusIntervals.lastSeenAt,
    })
    .from(cloudtalkStatusIntervals)
    .where(
      and(
        eq(cloudtalkStatusIntervals.department, department),
        inArray(cloudtalkStatusIntervals.managerId, managerIds),
        lt(cloudtalkStatusIntervals.startedAt, to),
        // Эффективный конец = ended_at, иначе last_seen_at. COALESCE сырым SQL:
        // выразить это через drizzle-хелперы нельзя, а сравнивать по одному
        // last_seen_at нельзя тем более — закрытый «живьём» интервал имеет
        // ended_at позже последнего подтверждения и выпал бы из окна.
        sql`COALESCE(${cloudtalkStatusIntervals.endedAt}, ${cloudtalkStatusIntervals.lastSeenAt}) >= ${from}`,
      ),
    );

  const out: PresenceRange[] = [];
  for (const r of rows) {
    const status = r.status as PresenceInterval["status"];
    if (!["online", "idle", "on_call", "offline"].includes(status)) continue;
    const endMs = (r.endedAt ?? r.lastSeenAt).getTime();
    const startMs = r.startedAt.getTime();
    if (endMs <= startMs) continue;
    out.push({ managerId: r.managerId, status, idleName: r.idleName, startMs, endMs });
  }
  return out;
}

/** Индекс manager → интервалы (отсортированы по началу). */
export function indexPresenceByManager(ranges: PresenceRange[]): Map<string, PresenceRange[]> {
  const map = new Map<string, PresenceRange[]>();
  for (const r of ranges) {
    const list = map.get(r.managerId);
    if (list) list.push(r);
    else map.set(r.managerId, [r]);
  }
  for (const list of map.values()) list.sort((a, b) => a.startMs - b.startMs);
  return map;
}

/** Интервалы одного дня, подрезанные по его границам. */
export function presenceForDay(
  ranges: PresenceRange[] | undefined,
  dayStartMs: number,
  dayEndMs: number,
): PresenceInterval[] {
  const out: PresenceInterval[] = [];
  for (const r of ranges ?? []) {
    const startMs = Math.max(r.startMs, dayStartMs);
    const endMs = Math.min(r.endMs, dayEndMs);
    if (endMs > startMs) {
      out.push({ status: r.status, idleName: r.idleName, startMs, endMs });
    }
  }
  return out;
}
