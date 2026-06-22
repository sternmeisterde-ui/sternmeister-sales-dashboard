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
