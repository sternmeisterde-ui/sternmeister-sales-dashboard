// WP0 — разведка контракта ОКК (D2 / B2G) для среза по менеджерам в Воронке.
// ТОЛЬКО ЧТЕНИЕ. Отвечает на 3 вопроса:
//   1. Какие prompt_type есть в D2 + сколько звонков/средний балл по каждому
//      (нужно для «ОКК по типу скрипта» и колонки «оценка консультаций»).
//   2. Насколько надёжно заполнен calls.kommo_lead_id (нужно для «средний ОКК
//      по сделке») + разрез по pipeline.
//   3. Стык identity менеджера: managers.kommo_user_id ↔ воронка
//      responsible_user_id (есть ли у скольких менеджеров kommo_user_id).
//
//   npx tsx scripts/diag-okk-contract-d2.ts

import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

import { sql } from "drizzle-orm";
import { d2OkkDb } from "../src/lib/db/okk";

type Row = Record<string, unknown>;

function rows(res: unknown): Row[] {
  // neon-http execute → { rows: [...] } | [...]
  if (Array.isArray(res)) return res as Row[];
  if (res && typeof res === "object" && Array.isArray((res as { rows?: Row[] }).rows)) {
    return (res as { rows: Row[] }).rows;
  }
  return [];
}

function table(label: string, data: Row[]): void {
  console.log(`\n=== ${label} ===`);
  if (data.length === 0) {
    console.log("  (нет строк)");
    return;
  }
  console.table(data);
}

async function main(): Promise<void> {
  // Реальные типы колонок calls (схема Drizzle могла разойтись с БД).
  const colTypes = rows(
    await d2OkkDb.execute(sql`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'calls'
        AND column_name IN ('kommo_lead_id','kommo_pipeline_id','kommo_contact_id','status','manager_id')
      ORDER BY column_name
    `)
  );
  table("Типы ключевых колонок calls", colTypes);

  // Реальные значения status (схема говорила pending/evaluated/error).
  const byStatus = rows(
    await d2OkkDb.execute(sql`
      SELECT status, COUNT(*)::int AS n
      FROM calls GROUP BY status ORDER BY n DESC
    `)
  );
  table("calls.status — реальные значения", byStatus);

  // Общая картина: сколько звонков и за какой период.
  const overview = rows(
    await d2OkkDb.execute(sql`
      SELECT
        COUNT(*)::int                                   AS calls_total,
        MIN(call_created_at)::date::text                AS first_call,
        MAX(call_created_at)::date::text                AS last_call
      FROM calls
    `)
  );
  table("Обзор D2.calls", overview);

  // 1. prompt_type из evaluations + средний балл + покрытие звонков.
  const byPromptType = rows(
    await d2OkkDb.execute(sql`
      SELECT
        e.prompt_type                                   AS prompt_type,
        COUNT(*)::int                                   AS evals,
        ROUND(AVG(e.total_score)::numeric, 1)           AS avg_score,
        MIN(c.call_created_at)::date::text              AS first_seen,
        MAX(c.call_created_at)::date::text              AS last_seen
      FROM evaluations e
      JOIN calls c ON c.id = e.call_id
      GROUP BY e.prompt_type
      ORDER BY evals DESC
    `)
  );
  table("1. evaluations.prompt_type (тип скрипта)", byPromptType);

  // 2a. Покрытие kommo_lead_id среди ОЦЕНЁННЫХ звонков (= есть строка в evaluations).
  const leadCoverage = rows(
    await d2OkkDb.execute(sql`
      SELECT
        COUNT(*)::int                                          AS scored_calls,
        COUNT(c.kommo_lead_id)::int                            AS with_lead_id,
        COUNT(c.kommo_contact_id)::int                         AS with_contact_id
      FROM calls c
      WHERE EXISTS (SELECT 1 FROM evaluations e WHERE e.call_id = c.id)
    `)
  );
  table("2a. Покрытие lead/contact id (оценённые звонки)", leadCoverage);

  // 2b. Разрез по kommo_pipeline_id (какие воронки в ОКК — ждём Бух Гос/Бератер).
  const byPipeline = rows(
    await d2OkkDb.execute(sql`
      SELECT
        c.kommo_pipeline_id                             AS pipeline_id,
        COUNT(*)::int                                   AS calls,
        COUNT(c.kommo_lead_id)::int                     AS with_lead
      FROM calls c
      WHERE EXISTS (SELECT 1 FROM evaluations e WHERE e.call_id = c.id)
      GROUP BY c.kommo_pipeline_id
      ORDER BY calls DESC
    `)
  );
  table("2b. Разрез по kommo_pipeline_id (оценённые)", byPipeline);

  // 3. Менеджеры: есть ли kommo_user_id для стыковки с воронкой.
  const managers = rows(
    await d2OkkDb.execute(sql`
      SELECT
        COUNT(*)::int                                          AS managers_total,
        COUNT(*) FILTER (WHERE kommo_user_id IS NOT NULL)::int AS with_kommo_user_id,
        COUNT(*) FILTER (WHERE is_active)::int                 AS active
      FROM managers
    `)
  );
  table("3. managers: покрытие kommo_user_id", managers);

  // 3b. Список активных менеджеров (имя + kommo_user_id + line) — для маппинга.
  const managerList = rows(
    await d2OkkDb.execute(sql`
      SELECT name, kommo_user_id, line, role
      FROM managers
      WHERE is_active = TRUE
      ORDER BY name
    `)
  );
  table("3b. Активные менеджеры D2", managerList);

  console.log("\nГотово. Только чтение, ничего не изменено.");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("Ошибка:", e);
    process.exit(1);
  });
