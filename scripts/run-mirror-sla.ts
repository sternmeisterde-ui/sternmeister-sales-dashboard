/**
 * One-off: invoke mirror-integrator-sla for a date window.
 * Usage: npx tsx scripts/run-mirror-sla.ts --from 2026-01-01 --to 2026-04-29
 */
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { mirrorIntegratorSla } from "@/lib/etl/mirror-integrator-sla";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const from = arg("from");
  const to = arg("to");
  if (!from || !to) {
    console.error("Usage: --from YYYY-MM-DD --to YYYY-MM-DD");
    process.exit(1);
  }
  const fromDate = new Date(`${from}T00:00:00Z`);
  const toDate = new Date(`${to}T23:59:59Z`);
  console.log(`[mirror-sla] window ${from}..${to}`);
  const res = await mirrorIntegratorSla(fromDate, toDate);
  console.log("[mirror-sla] done:", res);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
