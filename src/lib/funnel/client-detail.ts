/**
 * Детали клиента для drawer'а режима «Клиенты» (ТЗ §8: таймлайн касаний +
 * история стадий с длительностями). Грузится лениво при открытии карточки —
 * НЕ в общий список (там до 1000 строк).
 *
 * Scope: по lead_id сделки Бератера (как и вся таблица «Клиентов»). Кросс-воронку
 * (Гос-стадии/касания связанной сделки) пока не склеиваем — отдельное улучшение.
 */
import { sql } from "drizzle-orm";
import { analyticsDb } from "@/lib/db/analytics";
import { unwrapRows } from "./compute";

export interface ClientTouch {
  atIso: string;
  type: string | null; // communication_type (call/email/chat/note/...)
  durationSec: number | null;
  manager: string | null;
}

export interface ClientStage {
  status: string | null;
  enteredAtIso: string;
  leftAtIso: string | null; // null = текущая стадия
  days: number;
  manager: string | null;
}

export interface ClientDetail {
  touches: ClientTouch[];
  stages: ClientStage[];
}

const TOUCH_LIMIT = 80;

function toIso(v: string | Date | null): string | null {
  if (v === null) return null;
  if (v instanceof Date) return v.toISOString();
  // neon-http отдаёт timestamp(without tz) наивной строкой "YYYY-MM-DD HH:MM:SS"
  // (значения — UTC, см. ETL/schema). Возвращаем настоящий UTC-ISO, иначе
  // new Date() на клиенте парсит её как локальное время → сдвиг на смещение TZ.
  const s = String(v).trim();
  if (/[zZ]$|[+-]\d\d:?\d\d$/.test(s)) return s; // уже с зоной
  return s.replace(" ", "T") + "Z";
}

export async function getClientDetail(leadId: number): Promise<ClientDetail> {
  if (!Number.isInteger(leadId) || leadId <= 0) {
    return { touches: [], stages: [] };
  }

  const [touchRows, stageRows] = await Promise.all([
    unwrapRows<{
      type: string | null;
      createdAt: string | Date | null;
      duration: number | null;
      manager: string | null;
    }>(
      await analyticsDb.execute(sql`
        SELECT communication_type AS "type",
               created_at         AS "createdAt",
               duration           AS "duration",
               manager            AS "manager"
        FROM analytics.communications
        WHERE lead_id = ${leadId} AND created_at IS NOT NULL
        ORDER BY created_at DESC
        LIMIT ${TOUCH_LIMIT}
      `),
    ),
    unwrapRows<{
      status: string | null;
      eventAt: string | Date | null;
      manager: string | null;
    }>(
      await analyticsDb.execute(sql`
        SELECT status, event_at AS "eventAt", manager
        FROM analytics.lead_status_changes
        WHERE lead_id = ${leadId} AND event_at IS NOT NULL
        ORDER BY event_at ASC, sort ASC
      `),
    ),
  ]);

  const nowMs = Date.now();
  const DAY = 86_400_000;

  const touches: ClientTouch[] = touchRows.map((r) => ({
    atIso: toIso(r.createdAt) as string,
    type: r.type,
    durationSec: r.duration,
    manager: r.manager,
  }));

  // «Ушёл со стадии» = вход в СЛЕДУЮЩУЮ запись (по event_at). Колонке
  // next_event_at не доверяем: в данных она null у нескольких ранних строк, из-за
  // чего «текущей» помечалось бы сразу несколько стадий. Текущая = последняя.
  const stages: ClientStage[] = stageRows.map((r, i) => {
    const enteredIso = toIso(r.eventAt) as string;
    const enteredMs = Date.parse(enteredIso);
    const isCurrent = i === stageRows.length - 1;
    const leftIso = isCurrent ? null : (toIso(stageRows[i + 1].eventAt) as string);
    const leftMs = leftIso ? Date.parse(leftIso) : nowMs;
    return {
      status: r.status,
      enteredAtIso: enteredIso,
      leftAtIso: leftIso,
      days: Math.max(0, Math.floor((leftMs - enteredMs) / DAY)),
      manager: r.manager,
    };
  });

  return { touches, stages };
}
