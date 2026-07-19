/**
 * Зеркалит объективные оценки клиентских ролевок из ОКК (D2 `client_evaluations`)
 * в `analytics.client_roleplays`, откуда их читает Funnel Dashboard.
 *
 * Источник — соседний репо OKK (подсистема client-roleplay scoring, только D2/Госники):
 * Grok оценивает КЛИЕНТА в ролевке внутри звонков d2_berater / d2_berater2 →
 * score_5 (1..5) + breakdown. См. dev_docs/funnel/02-ЧТО-СДЕЛАНО-ЧТО-НУЖНО.md §3.4.
 *
 * Зеркалим roleplay_present=true (оценённые) И roleplay_present=false, где ролевка
 * РЕАЛЬНО была, но балл не выставлен (insufficient — мало материала / degenerate —
 * сбой авто-оценки). Исключаем только «ролевка не проведена» (нечего показывать).
 * У не-оценённых score_5/score_percent = null, различаем по gate_reason.
 * Окно — по `client_evaluations.created_at` (когда ОКК записал оценку, ~через 2ч
 * после звонка), НЕ по дате звонка: иначе инкрементальный тик пропустил бы
 * оценки, появившиеся позже своего звонка.
 *
 * Идемпотентно: ON CONFLICT (okk_call_id) DO UPDATE — пере-оценка обновляет балл,
 * Neon HTTP-ретраи безопасны (см. docs/etl-architecture.md).
 *
 * Авто-skip если D2_OKK_DATABASE_URL не задан.
 */

import { sql } from "drizzle-orm";
import { analyticsDb } from "@/lib/db/analytics";
import { d2OkkDb } from "@/lib/db/okk";

type D2RoleplayRow = {
  okk_call_id: string;
  lead_id: number | null;
  side: string;
  attempt: number | null;
  roleplay_at: string | null;
  score_5: number | null;
  score_percent: number | null;
  criterion_scores: unknown;
  model_used: string | null;
  gate_reason: string | null;
}

export async function syncClientRoleplays(
  fromDate: Date,
  toDate: Date,
): Promise<number> {
  if (!process.env.D2_OKK_DATABASE_URL) {
    console.log("[ETL] sync-client-roleplays: skipped (D2_OKK_DATABASE_URL not set)");
    return 0;
  }

  // Читаем D2: оценённые клиентские ролевки + дата звонка (UTC-наивная, как
  // остальные analytics-таблицы — Funnel сам конвертит в Europe/Berlin).
  const res = await d2OkkDb.execute<D2RoleplayRow>(sql`
    SELECT
      ce.call_id                                                   AS okk_call_id,
      ce.kommo_lead_id                                             AS lead_id,
      ce.side                                                      AS side,
      ce.roleplay_number                                          AS attempt,
      (COALESCE(c.call_created_at, ce.created_at) AT TIME ZONE 'UTC') AS roleplay_at,
      ce.score_5                                                  AS score_5,
      ce.score_percent                                            AS score_percent,
      ce.criterion_scores                                         AS criterion_scores,
      ce.model_used                                               AS model_used,
      ce.gate_reason                                              AS gate_reason
    FROM client_evaluations ce
    JOIN calls c ON c.id = ce.call_id
    WHERE (
        ce.roleplay_present = true
        -- ролевка была, но не оценена (мало материала / degenerate) — показываем с причиной;
        -- «ролевка не проведена» (менеджерский pre-gate) исключаем — показывать нечего.
        OR (ce.roleplay_present = false AND ce.gate_reason NOT ILIKE '%не проведена%')
      )
      AND ce.created_at >= ${fromDate}
      AND ce.created_at <= ${toDate}
  `);

  const rows = res.rows ?? [];
  if (rows.length === 0) {
    console.log(
      `[ETL] sync-client-roleplays: 0 rows for ${fromDate.toISOString().slice(0, 10)} → ${toDate.toISOString().slice(0, 10)}`,
    );
    return 0;
  }

  const upserted = await upsertRoleplays(rows);
  console.log(
    `[ETL] sync-client-roleplays: upserted ${upserted} roleplays for ${fromDate.toISOString().slice(0, 10)} → ${toDate.toISOString().slice(0, 10)}`,
  );
  return upserted;
}

/**
 * Per-row параметризованный upsert. Объём мал (ролевки — небольшое подмножество
 * звонков), поэтому строка-за-строкой проще и безопаснее ручной сборки VALUES с
 * JSONB-экранированием.
 */
async function upsertRoleplays(rows: D2RoleplayRow[]): Promise<number> {
  let count = 0;
  for (const r of rows) {
    const criterionJson =
      r.criterion_scores == null ? null : JSON.stringify(r.criterion_scores);
    await analyticsDb.execute(sql`
      INSERT INTO analytics.client_roleplays
        (okk_call_id, lead_id, side, attempt, roleplay_at,
         score_5, score_percent, criterion_scores, model_used, gate_reason)
      VALUES (
        ${r.okk_call_id}, ${r.lead_id}, ${r.side}, ${r.attempt}, ${r.roleplay_at},
        ${r.score_5}, ${r.score_percent},
        ${criterionJson}::jsonb, ${r.model_used}, ${r.gate_reason}
      )
      ON CONFLICT (okk_call_id) DO UPDATE SET
        lead_id          = EXCLUDED.lead_id,
        side             = EXCLUDED.side,
        attempt          = EXCLUDED.attempt,
        roleplay_at      = EXCLUDED.roleplay_at,
        score_5          = EXCLUDED.score_5,
        score_percent    = EXCLUDED.score_percent,
        criterion_scores = EXCLUDED.criterion_scores,
        model_used       = EXCLUDED.model_used,
        gate_reason      = EXCLUDED.gate_reason,
        synced_at        = NOW()
    `);
    count++;
  }
  return count;
}
