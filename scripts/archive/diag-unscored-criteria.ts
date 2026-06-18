// READ-ONLY: проверка, как в реальных R2-оценках хранятся scoring:false критерии
// (критические ошибки, talk ratio, потеря клиента) — score/max_score/тип значения.
//   npx tsx scripts/diag-unscored-criteria.ts
//
// Только SELECT. Берёт 5 последних оценённых B2C-звонков, печатает по каждому
// содержимое блоков «Критические ошибки» и «Экспертный блок» БЕЗ транскриптов/PII.
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { neon } from "@neondatabase/serverless";

const url = process.env.R2_OKK_DATABASE_URL;
if (!url) {
  console.error("R2_OKK_DATABASE_URL не задан в .env.local");
  process.exit(1);
}
const sql = neon(url);

interface EvalCriterion {
  name?: string;
  score?: unknown;
  max_score?: unknown;
}
interface EvalBlock {
  name?: string;
  block_score?: unknown;
  max_block_score?: unknown;
  criteria?: EvalCriterion[];
}

const TARGET_BLOCKS = new Set(["Критические ошибки", "Экспертный блок"]);

async function main() {
  const rows = (await sql`
    SELECT e.id, e.prompt_type, e.created_at, e.evaluation_json
    FROM evaluations e
    WHERE e.total_score IS NOT NULL
    ORDER BY e.created_at DESC
    LIMIT 5
  `) as Array<{ id: string; prompt_type: string | null; created_at: string; evaluation_json: { blocks?: EvalBlock[] } | null }>;

  for (const r of rows) {
    console.log(`\n=== eval ${r.id} | prompt=${r.prompt_type} | ${r.created_at} ===`);
    const blocks = r.evaluation_json?.blocks ?? [];
    const names = blocks.map((b) => b.name);
    console.log(`блоки: ${JSON.stringify(names)}`);
    for (const b of blocks) {
      if (!b.name || !TARGET_BLOCKS.has(b.name)) continue;
      console.log(`-- блок "${b.name}" block_score=${JSON.stringify(b.block_score)} max=${JSON.stringify(b.max_block_score)}`);
      for (const c of b.criteria ?? []) {
        console.log(
          `   "${c.name}" | score=${JSON.stringify(c.score)} (${typeof c.score}) | max_score=${JSON.stringify(c.max_score)} (${typeof c.max_score})`,
        );
      }
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
