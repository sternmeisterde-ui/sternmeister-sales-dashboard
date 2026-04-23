import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });
import { computeSla } from "../src/lib/etl/compute-sla";

async function main() {
  const from = new Date("2026-04-01T00:00:00Z");
  const to   = new Date("2026-04-23T23:59:59Z");
  console.log("Recomputing SLA with shift column...");
  const rows = await computeSla(from, to);
  console.log(`Done: ${rows} SLA rows updated`);
}
main().catch(console.error);
