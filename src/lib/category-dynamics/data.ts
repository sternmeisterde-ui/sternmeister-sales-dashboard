// Данные вкладки «Динамика категорий» (b2b): дневные агрегаты лидов и продаж
// по категориям CATEGORY (Kommo CFV 866934) из analytics.leads_cohort.
//
// «Правильное количество лидов» — воспроизводит эталонную выгрузку Kommo
// (dev_docs/kommo_export_leads_2026-07-14 (1).csv, июнь 2026 = 459 лидов,
// сверено 1в1):
//   • период — по дате СОЗДАНИЯ лида (Berlin);
//   • этап Incoming leads исключён (есть только у Бух Комм);
//   • удалённые лиды исключены;
//   • причины закрытия — поле 876383 «Причина закрытия (Обязательное поле)»:
//     исключены Спам/Неквал/Сотрудничество/3 дубля — тот же сет, что у SLA
//     (OWN_SLA_EXCLUDED_* из compute-sla, единая точка правды).
//
// «Продажа» = заполнена строгая факт-дата 1-го платежа (first_payment_fact_date,
// CFV 888296), когортно к дате создания лида — сверено с excel «Конверсия по
// категориям» (июнь: A=1 B=14 C=8 D=0 E=1 без=3).
import { sql } from "drizzle-orm";
import { analyticsDb } from "@/lib/db/analytics";
import { cached } from "@/lib/kommo/cache";
import {
  OWN_SLA_EXCLUDED_REASON_ENUM_IDS,
  OWN_SLA_EXCLUDED_LOSS_REASONS,
} from "@/lib/etl/compute-sla";
import {
  B2B_PIPELINES,
  COMMERCIAL_STATUSES,
  MEDICAL_COMM_STATUSES,
} from "@/lib/kommo/pipeline-config";

const CACHE_TTL = 5 * 60 * 1000;

export type CategoryFunnel = "buh" | "med" | "all";

/** Категории в порядке колонок таблицы. "" = «Без метки». */
export const CATEGORY_KEYS = ["A", "B", "C", "D", "E", ""] as const;
export type CategoryKey = (typeof CATEGORY_KEYS)[number];

export interface CategoryDayRow {
  /** Berlin civil date YYYY-MM-DD (по created_at лида). */
  date: string;
  /** "A".."E" или "" (без метки). */
  category: CategoryKey;
  leads: number;
  sales: number;
}

function pipelineIdsFor(funnel: CategoryFunnel): number[] {
  if (funnel === "buh") return [B2B_PIPELINES.COMMERCIAL];
  if (funnel === "med") return [B2B_PIPELINES.MEDICAL_COMM];
  return [B2B_PIPELINES.COMMERCIAL, B2B_PIPELINES.MEDICAL_COMM];
}

// Incoming leads исключаются из счёта (эталонная выгрузка их не содержит).
// Status id уникальны per-pipeline, поэтому безопасно исключать оба сразу:
// у Бух Комм это 81523499; у Мед Комм этап числится в конфиге (101858011),
// хотя B2B_MED_KOMLEADS_EXCLUDED_STATUSES считает, что этапа нет — если его
// действительно нет, условие просто не срабатывает.
const INCOMING_STATUS_IDS = [
  COMMERCIAL_STATUSES.INCOMING,
  MEDICAL_COMM_STATUSES.INCOMING,
];

/**
 * Дневные агрегаты категория × день за [fromTs, toTs] (unix-секунды, границы
 * Berlin-дней). Дни/категории без лидов отсутствуют — клиент дополняет нулями.
 */
export async function getCategoryDynamicsDays(
  funnel: CategoryFunnel,
  fromTs: number,
  toTs: number,
): Promise<CategoryDayRow[]> {
  const cacheKey = `category-dynamics:${funnel}:${fromTs}:${toTs}`;
  return cached(cacheKey, CACHE_TTL, () => fetchDays(funnel, fromTs, toTs));
}

async function fetchDays(
  funnel: CategoryFunnel,
  fromTs: number,
  toTs: number,
): Promise<CategoryDayRow[]> {
  const fromDate = new Date(fromTs * 1000);
  const toDate = new Date(toTs * 1000);
  const pipelineList = sql.join(
    pipelineIdsFor(funnel).map((id) => sql`${id}`),
    sql`, `,
  );
  const excludedEnumList = sql.join(
    [...OWN_SLA_EXCLUDED_REASON_ENUM_IDS].map((id) => sql`${id}`),
    sql`, `,
  );
  const excludedReasonList = sql.join(
    [...OWN_SLA_EXCLUDED_LOSS_REASONS].map((r) => sql`${r}`),
    sql`, `,
  );

  const result = await (analyticsDb as unknown as {
    execute: <T>(q: unknown) => Promise<{ rows: T[] }>;
  }).execute<{ d: string; cat: string; leads: string | number; sales: string | number }>(sql`
    SELECT
      ((created_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Berlin')::date::text AS d,
      UPPER(COALESCE(NULLIF(TRIM(category), ''), '')) AS cat,
      COUNT(*) AS leads,
      COUNT(*) FILTER (WHERE first_payment_fact_date IS NOT NULL) AS sales
    FROM analytics.leads_cohort
    WHERE pipeline_id IN (${pipelineList})
      AND created_at >= ${fromDate}
      AND created_at <= ${toDate}
      AND status_id NOT IN (${sql.join(INCOMING_STATUS_IDS.map((id) => sql`${id}`), sql`, `)})
      AND is_deleted = false
      -- Причина закрытия: авторитетно ТОЛЬКО обязательное поле 876383 (ТЗ:
      -- «не другие поля»). Текстовый loss_reason — фолбэк исключительно когда
      -- обязательное поле пустое: у старых лидов (март-2026 и раньше) поля
      -- противоречат друг другу (loss_reason=Спам при обязательном «Игнор»),
      -- и безусловный текст-фильтр терял таких лидов (-9 в марте vs выгрузка).
      -- NB: у SLA (compute-sla) намеренно ДРУГАЯ логика — исключает по OR.
      AND (
        CASE
          WHEN b2b_close_reason_enum_id IS NOT NULL
            THEN b2b_close_reason_enum_id NOT IN (${excludedEnumList})
          ELSE (loss_reason IS NULL OR loss_reason NOT IN (${excludedReasonList}))
        END
      )
    GROUP BY 1, 2
    ORDER BY 1, 2
  `);

  return result.rows.map((r) => {
    const cat = (CATEGORY_KEYS as readonly string[]).includes(r.cat)
      ? (r.cat as CategoryKey)
      : ""; // неожиданное значение поля → «Без метки»
    return {
      date: r.d,
      category: cat,
      leads: Number(r.leads),
      sales: Number(r.sales),
    };
  });
}
