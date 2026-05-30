// Direct ETL runner — bypasses Next.js HTTP layer entirely
// Usage: npx tsx scripts/etl-sync.ts [from] [to]
// Example: npx tsx scripts/etl-sync.ts 2026-04-16 2026-04-23
//
// Loads .env.local automatically so callers don't need the
// --env-file flag (matches the apply-migration-*.ts pattern).
import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

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
