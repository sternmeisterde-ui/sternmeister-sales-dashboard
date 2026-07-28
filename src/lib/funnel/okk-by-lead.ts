/**
 * Агрегаты ОКК по сделке (D2 `evaluations`) для скоринга «Готовности» (ТЗ §7):
 *   consultOkk — средний балл консультационных звонков (prompt d2_berater/berater2);
 *   dealOkk    — средний балл ВСЕХ оценённых звонков сделки.
 * Дедуп ре-оценок: берём последнюю evaluations-строку на call_id (DISTINCT ON).
 * Связь: calls.kommo_lead_id (TEXT в D2) = наш lead_id.
 */
import { sql } from "drizzle-orm";
import { d2OkkDb } from "@/lib/db/okk";
import { unwrapRows } from "./compute";
import type { Vertical } from "@/lib/kommo/pipeline-config";

export interface OkkByLead {
  consultOkk: number | null; // 0..100
  dealOkk: number | null; // 0..100
}

export async function getOkkByLead(leadIds: number[]): Promise<Map<number, OkkByLead>> {
  const out = new Map<number, OkkByLead>();
  const ids = Array.from(new Set(leadIds.filter((n) => Number.isInteger(n) && n > 0)));
  if (ids.length === 0) return out;

  try {
    const inList = ids.map((n) => `'${n}'`).join(","); // ids — валидированные целые
    const rows = unwrapRows<{
      lead_id: string | number | null;
      consult: string | number | null;
      deal: string | number | null;
    }>(
      await d2OkkDb.execute(sql`
        WITH latest AS (
          SELECT DISTINCT ON (e.call_id)
                 c.kommo_lead_id AS lead_id,
                 e.total_score   AS score,
                 e.prompt_type   AS prompt
          FROM evaluations e
          JOIN calls c ON c.id = e.call_id
          WHERE c.kommo_lead_id IN (${sql.raw(inList)})
            AND e.total_score IS NOT NULL
          ORDER BY e.call_id, e.created_at DESC
        )
        SELECT lead_id,
               avg(score) FILTER (WHERE prompt IN ('d2_berater','d2_berater2')) AS consult,
               avg(score) AS deal
        FROM latest
        GROUP BY lead_id
      `),
    );
    for (const r of rows) {
      const leadId = Number(r.lead_id);
      if (!Number.isInteger(leadId)) continue;
      out.set(leadId, {
        consultOkk: r.consult == null ? null : Math.round(Number(r.consult)),
        dealOkk: r.deal == null ? null : Math.round(Number(r.deal)),
      });
    }
  } catch (e) {
    console.error("[funnel] getOkkByLead failed (non-fatal):", e instanceof Error ? e.message : e);
  }
  return out;
}

/** prompt_type консультационных звонков по вертикали (ДЦ + АА). */
function consultPromptTypes(vertical?: Vertical): string[] {
  const buh = ["d2_berater", "d2_berater2"];
  const med = ["d2_med_berater", "d2_med_berater2"];
  if (vertical === "med") return med;
  if (vertical === "all") return [...buh, ...med];
  return buh; // undefined = буховая (legacy), как в остальных funnel-выборках
}

/**
 * Сколько КОНСУЛЬТАЦИОННЫХ звонков реально проведено по каждой Бератер-сделке.
 *
 * Считаем факт звонка, а не событие CRM: раньше «Конс.» брала входы в статусы
 * «Консультация … проведена» из lead_status_changes, и любая перестановка
 * статуса туда-обратно накручивала счётчик. Источник правды — разобранные ОКК
 * консультации (`evaluations.prompt_type`), дедуп `COUNT(DISTINCT call_id)`:
 * ре-оценка одного звонка не должна считаться второй консультацией.
 *
 * NB: это звонки, дошедшие до оценки ОКК (транскрипция + eval). Слишком короткие
 * / отфильтрованные по статусу сюда не попадают — для «Конс.» это и нужно
 * (консультация = состоявшийся разговор), но не путать с общим числом звонков.
 */
export async function getConsultCallCountsByLead(
  leadIds: number[],
  vertical?: Vertical,
): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  const ids = Array.from(new Set(leadIds.filter((n) => Number.isInteger(n) && n > 0)));
  if (ids.length === 0) return out;

  try {
    const inList = ids.map((n) => `'${n}'`).join(","); // ids — валидированные целые
    const prompts = consultPromptTypes(vertical)
      .map((p) => `'${p}'`)
      .join(",");
    const rows = unwrapRows<{ lead_id: string | number | null; n: string | number | null }>(
      await d2OkkDb.execute(sql`
        SELECT c.kommo_lead_id AS lead_id, COUNT(DISTINCT e.call_id) AS n
        FROM evaluations e
        JOIN calls c ON c.id = e.call_id
        WHERE c.kommo_lead_id IN (${sql.raw(inList)})
          AND e.prompt_type IN (${sql.raw(prompts)})
        GROUP BY c.kommo_lead_id
      `),
    );
    for (const r of rows) {
      const leadId = Number(r.lead_id);
      if (!Number.isInteger(leadId)) continue;
      out.set(leadId, Number(r.n) || 0);
    }
  } catch (e) {
    console.error(
      "[funnel] getConsultCallCountsByLead failed (non-fatal):",
      e instanceof Error ? e.message : e,
    );
  }
  return out;
}
