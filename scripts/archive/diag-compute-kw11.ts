// Прогоняет computeCohorts() напрямую и печатает KW 11 2026 для всех конверсий.
//
//   npx tsx scripts/diag-compute-kw11.ts

import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

import { computeCohorts } from "../src/lib/funnel/compute";

async function main(): Promise<void> {
  const result = await computeCohorts({
    from: new Date("2025-12-01T00:00:00Z"),
    to: new Date("2026-06-02T00:00:00Z"),
    maturity: "all",
    source: null,
    responsibleUserId: null,
  });

  console.log("=== Funnel C1 — последние недели ===\n");
  const c1 = result.cohorts
    .filter((c) => c.conversionId === "C1")
    .sort((a, b) => b.weekStartIso.localeCompare(a.weekStartIso));
  for (const c of c1) {
    const pct = c.conversionPct === null ? "—" : `${c.conversionPct.toFixed(1)}%`;
    const qpct = c.disqualificationPct === null
      ? "—"
      : `${(100 - c.disqualificationPct).toFixed(1)}%`;
    console.log(
      `${c.weekStartIso} ${c.isoLabel} | base=${String(c.baseCount).padStart(3)} | target=${String(c.targetCount).padStart(3)} | conv%=${pct.padStart(6)} | disq=${String(c.disqualifiedCount).padStart(3)} | квал%=${qpct.padStart(6)} | ${c.maturityState}`,
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("fatal:", e);
    process.exit(1);
  });
