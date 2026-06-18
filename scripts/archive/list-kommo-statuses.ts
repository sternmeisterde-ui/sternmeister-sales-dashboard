// One-shot diagnostic: dump every Kommo pipeline + status for the
// departments the dashboard actually slices on (B2G + B2B). Used to verify
// that liveStatusNames in the dashboard route covers every status the user
// might see in the cohort table — no "Status 12345" leaks.
//
// Usage: npx tsx scripts/list-kommo-statuses.ts

import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { getPipelines } from "@/lib/kommo/client";
import { B2G_PIPELINES, B2B_PIPELINES } from "@/lib/kommo/pipeline-config";

async function main() {
  const all = await getPipelines();

  const byId = new Map<number, typeof all[number]>();
  for (const p of all) byId.set(p.id, p);

  const printPipeline = (id: number) => {
    const p = byId.get(id);
    if (!p) {
      console.log(`  [pipeline ${id}] NOT FOUND in account`);
      return 0;
    }
    const statuses = p._embedded?.statuses ?? [];
    console.log(`\n  ▶ ${p.name} (id=${p.id}) — ${statuses.length} статусов`);
    for (const s of [...statuses].sort((a, b) => a.sort - b.sort)) {
      const typeLabel = s.type === 1 ? " [WON]" : s.type === 2 ? " [LOST]" : "";
      console.log(`     ${String(s.id).padStart(10)} · ${s.name}${typeLabel}`);
    }
    return statuses.length;
  };

  let total = 0;
  console.log("=".repeat(70));
  console.log("B2G (Госники) — pipelines used by dashboard");
  console.log("=".repeat(70));
  total += printPipeline(B2G_PIPELINES.FIRST_LINE);
  total += printPipeline(B2G_PIPELINES.BERATER);

  console.log("\n" + "=".repeat(70));
  console.log("B2B (Коммерция) — pipelines used by dashboard");
  console.log("=".repeat(70));
  total += printPipeline(B2B_PIPELINES.COMMERCIAL);
  total += printPipeline(B2B_PIPELINES.MEDICAL_COMM);

  console.log("\n" + "=".repeat(70));
  console.log(`Total statuses across these 4 pipelines: ${total}`);
  console.log(`Total pipelines in this Kommo account: ${all.length}`);
  console.log("=".repeat(70));

  // Also dump unmapped pipelines so we know what we're NOT showing.
  const usedIds = new Set([
    B2G_PIPELINES.FIRST_LINE, B2G_PIPELINES.BERATER,
    B2B_PIPELINES.COMMERCIAL, B2B_PIPELINES.MEDICAL_COMM,
  ]);
  console.log("\nOther pipelines in this account (not on dashboard):");
  for (const p of all) {
    if (usedIds.has(p.id)) continue;
    console.log(`  ${p.id} · ${p.name} (${(p._embedded?.statuses ?? []).length} статусов)`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
