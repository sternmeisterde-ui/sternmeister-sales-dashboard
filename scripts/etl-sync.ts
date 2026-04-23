// Direct ETL runner — bypasses Next.js HTTP layer entirely
// Usage: npx tsx --env-file .env.local scripts/etl-sync.ts [from] [to]
// Example: npx tsx --env-file .env.local scripts/etl-sync.ts 2026-04-16 2026-04-23
import { runSync } from "../src/lib/etl/index";

const [fromArg, toArg] = process.argv.slice(2);

const fromDate = fromArg
  ? new Date(`${fromArg}T00:00:00Z`)
  : new Date(Date.now() - 7 * 86_400_000);

const toDate = toArg
  ? new Date(`${toArg}T23:59:59Z`)
  : new Date();

console.log(`[ETL] from=${fromDate.toISOString()} to=${toDate.toISOString()}`);

runSync({ fromDate, toDate })
  .then((result) => {
    console.log("[ETL] done:", result);
    process.exit(0);
  })
  .catch((err) => {
    console.error("[ETL] failed:", err);
    process.exit(1);
  });
