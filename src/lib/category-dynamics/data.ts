// Данные вкладки «Динамика категорий» (b2b): дневные агрегаты лидов и продаж
// по пяти измерениям из analytics.leads_cohort — категория CATEGORY (Kommo
// CFV 866934) и четыре ответа анкеты сайта (START_DATE 869932, INCOME 869938,
// STATUS 869936, LANGUAGE_LEVEL 869928).
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
//
// Ответы анкеты хранятся сырым текстом (форматы исторически дрейфуют:
// «До 2 000» / «До 2000 евро» / «До 2 000 €») — корзины нормализуются здесь,
// в SQL. Пустое/неожиданное значение → корзина "" («Без ответа»).
import { sql, type SQL } from "drizzle-orm";
import { analyticsDb } from "@/lib/db/analytics";
import { cached } from "@/lib/kommo/cache";
import {
  B2B_PIPELINES,
  COMMERCIAL_STATUSES,
  MEDICAL_COMM_STATUSES,
} from "@/lib/kommo/pipeline-config";

const CACHE_TTL = 5 * 60 * 1000;

// Исключаемые причины закрытия (поле 876383) — сет ЭТОЙ вкладки, сверен 1в1
// с эталонными выгрузками Kommo (июнь 459, март 500). НЕ путать с сетом SLA
// в compute-sla.ts: тот шире (+ Гос. клиент, Неправильный контакт по решению
// Рузанны 2026-07-20) — с 2026-07-20 списки НАМЕРЕННО разные.
const EXCLUDED_REASON_ENUM_IDS = new Set([
  740593, // Спам
  740587, // Неквал лид
  740595, // Предложение сотрудничества
  752414, // Дубль, госник
  753716, // Бух дубль
  753718, // Мед дубль
]);
const EXCLUDED_LOSS_REASONS = new Set([
  "Спам",
  "Неквал лид",
  "Предложение сотрудничества",
  "Дубль, госник",
  "Бух дубль",
  "Мед дубль",
]);

export type CategoryFunnel = "buh" | "med" | "all";

/** Измерения вкладки — порядок = порядок таблиц на странице. */
export const DIMENSION_KEYS = [
  "category",
  "startDate",
  "income",
  "status",
  "language",
] as const;
export type DimensionKey = (typeof DIMENSION_KEYS)[number];

/**
 * Корзины каждого измерения в порядке колонок таблицы. "" = «Без метки» /
 * «Без ответа» (пустое поле или неожиданное значение). Подписи и цвета —
 * на клиенте (CategoryDynamicsTab).
 */
export const DIM_BUCKETS: Record<DimensionKey, readonly string[]> = {
  category: ["A", "B", "C", "D", "E", ""],
  // NB: ключ "later" (не "none") — "none" сталкивался с fallback-ключом
  // пустой корзины в React-key таблицы.
  startDate: ["now", "2w", "1m", "later", ""],
  income: ["lt2", "2to3", "3to5", "gt5", ""],
  status: ["de_job", "spouse", "freelance", "no_job", "job_abroad", "benefit", ""],
  language: ["A1", "A2", "B1", "B2", "C1", "C2", ""],
};

/** Совместимость: порядок колонок таблицы категорий. */
export const CATEGORY_KEYS = DIM_BUCKETS.category;
export type CategoryKey = (typeof DIM_BUCKETS.category)[number];

export interface DimensionDayRow {
  /** Berlin civil date YYYY-MM-DD (по created_at лида). */
  date: string;
  /** Ключ корзины измерения (см. DIM_BUCKETS) или "" (без метки/ответа). */
  bucket: string;
  leads: number;
  sales: number;
}

export type CategoryDynamicsDays = Record<DimensionKey, DimensionDayRow[]>;

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
 * SQL-выражение корзины измерения. Нормализация — только на чтении, сырые
 * значения в leads_cohort не трогаем (правила могут уточняться без бэкфилла).
 */
function bucketExpr(dim: DimensionKey): SQL {
  switch (dim) {
    case "category":
      return sql`UPPER(COALESCE(NULLIF(TRIM(category), ''), ''))`;
    case "startDate":
      // Значения чистые — единственный вопрос без дрейфа форматов.
      return sql`
        CASE TRIM(COALESCE(start_date_answer, ''))
          WHEN 'Прямо сейчас' THEN 'now'
          WHEN 'Через 2 недели' THEN '2w'
          WHEN 'Через месяц' THEN '1m'
          WHEN 'Не планирую в ближайшее время' THEN 'later'
          ELSE ''
        END`;
    case "income":
      // Форматы дрейфуют: «До 2 000» / «До 2000 евро» / «До 2 000 €»,
      // «2 000 3 000» / «2000 - 3000 евро» / «2 000 – 3 000 €». Средние
      // корзины ловим по цифрам (все нецифры вон), крайние — по префиксу.
      return sql`
        CASE
          WHEN COALESCE(TRIM(income_answer), '') = '' THEN ''
          WHEN TRIM(income_answer) LIKE 'До%' THEN 'lt2'
          WHEN TRIM(income_answer) LIKE 'Выше%' THEN 'gt5'
          WHEN regexp_replace(income_answer, '[^0-9]', '', 'g') = '20003000' THEN '2to3'
          WHEN regexp_replace(income_answer, '[^0-9]', '', 'g') = '30005000' THEN '3to5'
          ELSE ''
        END`;
    case "status":
      // «муж/жена» и опечатка «мужжена» — один ответ. «Получаю пособие, не
      // работаю» — реальный ответ анкеты, отсутствующий в исходном списке
      // Рузанны; по решению 2026-07-21 — отдельная корзина.
      return sql`
        CASE
          WHEN COALESCE(TRIM(status_answer), '') = '' THEN ''
          WHEN TRIM(status_answer) = 'Работаю в Германии' THEN 'de_job'
          WHEN TRIM(status_answer) = 'Работаю не в Германии' THEN 'job_abroad'
          WHEN TRIM(status_answer) = 'Фриланс' THEN 'freelance'
          WHEN status_answer LIKE '%муж%' THEN 'spouse'
          WHEN status_answer LIKE 'Получаю пособие%' THEN 'benefit'
          WHEN status_answer LIKE 'Не работаю, не получаю%' THEN 'no_job'
          ELSE ''
        END`;
    case "language":
      // Короткие «B1» и длинные «B1 (Средний уровень) — …»; бывает
      // кириллическая «А» («А1 (Начальный уровень)»). TRANSLATE переводит
      // кириллицу до UPPER: UPPER в C-locale не трогает не-ASCII.
      return sql`
        CASE
          WHEN UPPER(TRANSLATE(LEFT(TRIM(COALESCE(language_level, '')), 2), 'АВСавс', 'ABCabc'))
               IN ('A1', 'A2', 'B1', 'B2', 'C1', 'C2')
            THEN UPPER(TRANSLATE(LEFT(TRIM(language_level), 2), 'АВСавс', 'ABCabc'))
          ELSE ''
        END`;
  }
}

/**
 * Дневные агрегаты корзина × день по всем измерениям за [fromTs, toTs]
 * (unix-секунды, границы Berlin-дней). Дни/корзины без лидов отсутствуют —
 * клиент дополняет нулями.
 */
export async function getCategoryDynamicsDays(
  funnel: CategoryFunnel,
  fromTs: number,
  toTs: number,
): Promise<CategoryDynamicsDays> {
  const cacheKey = `category-dynamics:v3:${funnel}:${fromTs}:${toTs}`;
  return cached(cacheKey, CACHE_TTL, async () => {
    const perDim = await Promise.all(
      DIMENSION_KEYS.map((dim) => fetchDays(dim, funnel, fromTs, toTs)),
    );
    return Object.fromEntries(
      DIMENSION_KEYS.map((dim, i) => [dim, perDim[i]]),
    ) as CategoryDynamicsDays;
  });
}

async function fetchDays(
  dim: DimensionKey,
  funnel: CategoryFunnel,
  fromTs: number,
  toTs: number,
): Promise<DimensionDayRow[]> {
  const fromDate = new Date(fromTs * 1000);
  const toDate = new Date(toTs * 1000);
  const pipelineList = sql.join(
    pipelineIdsFor(funnel).map((id) => sql`${id}`),
    sql`, `,
  );
  const excludedEnumList = sql.join(
    [...EXCLUDED_REASON_ENUM_IDS].map((id) => sql`${id}`),
    sql`, `,
  );
  const excludedReasonList = sql.join(
    [...EXCLUDED_LOSS_REASONS].map((r) => sql`${r}`),
    sql`, `,
  );

  const result = await (analyticsDb as unknown as {
    execute: <T>(q: unknown) => Promise<{ rows: T[] }>;
  }).execute<{ d: string; b: string; leads: string | number; sales: string | number }>(sql`
    SELECT
      ((created_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Berlin')::date::text AS d,
      ${bucketExpr(dim)} AS b,
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

  const allowed = DIM_BUCKETS[dim] as readonly string[];
  return result.rows.map((r) => ({
    date: r.d,
    // Неожиданное значение поля → «Без метки»/«Без ответа» (страховка: SQL
    // уже отдаёт '' для всего вне корзин, кроме category — там пропускает
    // любой UPPER-текст).
    bucket: allowed.includes(r.b) ? r.b : "",
    leads: Number(r.leads),
    sales: Number(r.sales),
  }));
}
