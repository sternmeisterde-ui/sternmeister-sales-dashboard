// Бэкфилл истории CFV 879824 ("Причина закрытия госники") из Kommo
// за период. Чанками по месяцам, ~1 req/sec.
//
//   npx tsx scripts/backfill-close-reason-changes.ts                  # 2025-01-01 → today
//   npx tsx scripts/backfill-close-reason-changes.ts 2024-06-01       # с указ.
//   npx tsx scripts/backfill-close-reason-changes.ts 2024-06-01 2025-12-31

import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

import { syncCloseReasonChanges } from "../src/lib/etl/sync-close-reason-changes";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const [fromArg, toArg] = args;

  const fromStr = fromArg ?? "2025-01-01";
  const toStr = toArg ?? new Date().toISOString().slice(0, 10);

  const fromDate = new Date(`${fromStr}T00:00:00Z`);
  const toDate = new Date(`${toStr}T23:59:59Z`);

  console.log("=== Backfill lead_close_reason_changes (CFV 879824) ===");
  console.log(`Range: ${fromStr} → ${toStr}\n`);

  const cursor = new Date(
    Date.UTC(fromDate.getUTCFullYear(), fromDate.getUTCMonth(), 1, 0, 0, 0),
  );
  let total = 0;
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
      const upserted = await syncCloseReasonChanges(windowStart, windowEnd);
      const sec = (Date.now() - ts) / 1000;
      total += upserted;
      totalSec += sec;
      console.log(
        `[${label}] ${windowStart.toISOString().slice(0, 10)} → ${windowEnd.toISOString().slice(0, 10)} — ${upserted} events (${sec.toFixed(1)}s)`,
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
    `\n=== TOTAL: ${total} events за ${totalSec.toFixed(1)}s ===`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("fatal:", e);
    process.exit(1);
  });
