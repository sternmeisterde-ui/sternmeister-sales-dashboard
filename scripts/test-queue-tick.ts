// Проверка полного пути через очередь на реальной таблице:
//   detectWonExports() (окно EXPORT_SINCE_DAYS) → processPendingExports(limit).
//   npx tsx scripts/test-queue-tick.ts
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });
import net from "node:net";
import dns from "node:dns";
net.setDefaultAutoSelectFamily(false);
dns.setDefaultResultOrder("ipv4first");

import { detectWonExports } from "../src/lib/etl/detect-won-exports";
import { processPendingExports } from "../src/lib/exports/process-export";

async function main() {
  console.log("1) detectWonExports() …");
  const queued = await detectWonExports();
  console.log(`   в очередь добавлено: ${queued}`);

  console.log("\n2) processPendingExports(1) — один контакт …");
  const res = await processPendingExports(1);
  console.log("   результат:", JSON.stringify(res));
}

main().then(() => process.exit(0)).catch((e) => {
  console.error("\n❌ Упало:", e instanceof Error ? e.stack : e);
  process.exit(1);
});
