// Узкий backfill: тянет ТОЛЬКО analytics.leads_cohort (через syncLeads),
// без communications/SLA/status_changes/tasks — чтобы заполнить новые колонки
// language_level / exclude_from_analytics / updated_at для исторических лидов.
//
// Не использует runSync() (та запускает всю ETL-цепочку, отсюда часы у backfill-analytics.ts).
// Прямой syncLeads → DELETE+INSERT по окну created_at, обновляет ВСЕ поля
// leads_cohort включая новые. Kommo /api/v4/leads пагинируется 250/стр.
//
// Запуск:
//   npx tsx scripts/backfill-funnel-extras.ts                  # 2025-01-01 → today
//   npx tsx scripts/backfill-funnel-extras.ts 2024-06-01       # с указ. даты → today
//   npx tsx scripts/backfill-funnel-extras.ts 2024-06-01 2025-12-31

import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

import { fetchLookups } from "../src/lib/etl/lookups";
import { syncLeads } from "../src/lib/etl/sync-leads";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const [fromArg, toArg] = args;

  const fromStr = fromArg ?? "2025-01-01";
  const toStr = toArg ?? new Date().toISOString().slice(0, 10);

  const fromDate = new Date(`${fromStr}T00:00:00Z`);
  const toDate = new Date(`${toStr}T23:59:59Z`);

  console.log("=== Funnel extras backfill (только leads_cohort) ===");
  console.log(`Range: ${fromStr} → ${toStr}`);
  console.log(
    "Только syncLeads — никаких communications/SLA/status_changes/tasks.\n",
  );

  // Lookups (пайплайны, юзеры, причины потерь) нужны syncLeads.
  console.log("Загружаю lookups из Kommo...");
  const t0 = Date.now();
  const lookups = await fetchLookups();
  console.log(`  done ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

  const cursor = new Date(
    Date.UTC(fromDate.getUTCFullYear(), fromDate.getUTCMonth(), 1, 0, 0, 0),
  );
  let totalLeads = 0;
  let totalSec = 0;

  while (cursor <= toDate) {
    const monthEnd = new Date(
      Date.UTC(
        cursor.getUTCFullYear(),
        cursor.getUTCMonth() + 1,
        0,
        23,
        59,
        59,
      ),
    );
    const windowStart = cursor < fromDate ? fromDate : cursor;
    const windowEnd = monthEnd > toDate ? toDate : monthEnd;
    const label = cursor.toISOString().slice(0, 7);

    const ts = Date.now();
    try {
      const cache = await syncLeads(
        windowStart,
        windowEnd,
        lookups,
        "created_at",
      );
      const sec = (Date.now() - ts) / 1000;
      totalLeads += cache.length;
      totalSec += sec;
      console.log(
        `[${label}] ${windowStart.toISOString().slice(0, 10)} → ${windowEnd.toISOString().slice(0, 10)} — ${cache.length} leads (${sec.toFixed(1)}s)`,
      );
    } catch (e) {
      console.error(
        `[${label}] FAILED:`,
        e instanceof Error ? e.message : String(e),
      );
    }

    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }

  console.log(
    `\n=== TOTAL: ${totalLeads} лидов за ${totalSec.toFixed(1)}s ===`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("fatal:", e);
    process.exit(1);
  });
