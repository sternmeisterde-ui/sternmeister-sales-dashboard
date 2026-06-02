// Разовый backfill: переносит ВСЕ существующие оценки клиентских ролевок из
// D2 client_evaluations (roleplay_present=true) в analytics.client_roleplays.
//
// Переиспользует тот же ETL-шаг, что и cron — просто с широким окном (epoch → now),
// поэтому логика одна и та же (DRY). Идемпотентно (ON CONFLICT DO UPDATE).
//
// Предусловие: миграция применена — `npx tsx scripts/apply-migration-0023.ts`.
//
//   npx tsx scripts/backfill-client-roleplays.ts
import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

import { syncClientRoleplays } from "../src/lib/etl/sync-client-roleplays";

async function main(): Promise<void> {
  console.log("=== Backfill analytics.client_roleplays (from D2) ===");
  const from = new Date("2000-01-01T00:00:00Z"); // epoch — все строки по eval.created_at
  const to = new Date();

  const t0 = Date.now();
  const n = await syncClientRoleplays(from, to);
  console.log(`\nDone: ${n} roleplays mirrored in ${Date.now() - t0}ms ✅`);
  console.log(
    "Проверка: SELECT count(*), round(avg(score_5),2) FROM analytics.client_roleplays;",
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("fatal:", e);
    process.exit(1);
  });
