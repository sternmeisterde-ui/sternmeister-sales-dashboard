// READ-ONLY диагностика: что реально лежит в D2 client_evaluations
// (на которую смотрит Dashboard через D2_OKK_DATABASE_URL).
//   npx tsx scripts/diag-client-roleplays.ts
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { sql } from "drizzle-orm";
import { d2OkkDb } from "../src/lib/db/okk";

async function main(): Promise<void> {
  // 1. Существует ли таблица?
  const exists = await d2OkkDb.execute<{ exists: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_name = 'client_evaluations'
    ) AS exists
  `);
  console.log("client_evaluations exists:", exists.rows[0]?.exists);
  if (!exists.rows[0]?.exists) {
    console.log("❌ Таблицы нет в этой D2-ветке. ОКК пишет в другую базу/ветку.");
    return;
  }

  // 2. Счётчики
  const counts = await d2OkkDb.execute<{
    total: number; present_true: number; present_false: number;
    scored: number; min_created: string | null; max_created: string | null;
  }>(sql`
    SELECT
      count(*)                                              AS total,
      count(*) FILTER (WHERE roleplay_present = true)       AS present_true,
      count(*) FILTER (WHERE roleplay_present = false)      AS present_false,
      count(*) FILTER (WHERE score_5 IS NOT NULL)           AS scored,
      min(created_at)::text                                 AS min_created,
      max(created_at)::text                                 AS max_created
    FROM client_evaluations
  `);
  console.table(counts.rows);

  // 3. Разбивка по стороне + есть ли join к calls
  const bySide = await d2OkkDb.execute(sql`
    SELECT side, count(*) AS n,
           count(*) FILTER (WHERE roleplay_present = true) AS present_true
    FROM client_evaluations GROUP BY side ORDER BY side
  `);
  console.log("by side:");
  console.table(bySide.rows);

  // 4. Сколько present=true имеют валидный join к calls (как в ETL)
  const joined = await d2OkkDb.execute<{ joinable: number }>(sql`
    SELECT count(*) AS joinable
    FROM client_evaluations ce JOIN calls c ON c.id = ce.call_id
    WHERE ce.roleplay_present = true
  `);
  console.log("present=true с join к calls (то, что заберёт ETL):", joined.rows[0]?.joinable);

  // 5. Менеджерские оценки берётера — КАЖДАЯ должна порождать строку
  //    в client_evaluations (даже present=false). Если их много, а
  //    client_evaluations пуст — значит клиентский путь не отрабатывает.
  const beraterEvals = await d2OkkDb.execute(sql`
    SELECT prompt_type, count(*) AS n, max(created_at)::text AS last_eval
    FROM evaluations
    WHERE prompt_type IN ('d2_berater','d2_berater2')
    GROUP BY prompt_type ORDER BY prompt_type
  `);
  console.log("\nменеджерские оценки берётера (должны порождать client_evaluations):");
  console.table(beraterEvals.rows);

  // 6. За последние 6 часов (примерно с деплоя ОКК)
  const recent = await d2OkkDb.execute<{ n: number }>(sql`
    SELECT count(*) AS n FROM evaluations
    WHERE prompt_type IN ('d2_berater','d2_berater2')
      AND created_at > now() - interval '6 hours'
  `);
  console.log("berater evals за последние 6ч (после деплоя):", recent.rows[0]?.n);
}

main().then(() => process.exit(0)).catch((e) => { console.error("fatal:", e); process.exit(1); });
