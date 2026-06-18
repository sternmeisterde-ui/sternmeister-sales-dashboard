// READ-ONLY: проверяет computeOverview на реальных данных за 6 мес.
//   npx tsx scripts/diag-overview.ts
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { computeOverview } from "../src/lib/funnel/overview";
import { computeCohorts } from "../src/lib/funnel/compute";
import type { ConversionId } from "../src/lib/funnel/types";

function berlinToday() {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit",
  });
  const [y, m, d] = f.format(new Date()).split("-").map(Number);
  return { y, m, d };
}

async function main(): Promise<void> {
  const { y, m, d } = berlinToday();
  const to = new Date(Date.UTC(y, m - 1, d));
  const from = new Date(Date.UTC(y, m - 1, d));
  from.setUTCMonth(from.getUTCMonth() - 6);

  const res = await computeOverview({ from, to, maturity: "all", source: null, responsibleUserId: null });

  console.log("\n=== KPI ===");
  console.table([{
    "C5 %": res.kpi.c5Pct?.toFixed(1) ?? "—",
    "Активных": res.kpi.activeClients,
    "Ср.срок квал→Гутшайн (дн)": res.kpi.avgDaysQualToGutschein?.toFixed(1) ?? "—",
    [`Без звонка >${res.kpi.freshCallThresholdDays}д`]: res.kpi.noFreshCallCount,
    "Hot/Warm/Cold": res.kpi.hotWarmCold
      ? `${res.kpi.hotWarmCold.hot}/${res.kpi.hotWarmCold.warm}/${res.kpi.hotWarmCold.cold}`
      : "заглушка",
  }]);

  console.log("\n=== Воронка ===");
  console.table(res.funnel.map((s) => ({
    Этап: s.label,
    Дошло: s.count,
    "% перехода": s.transitionPctFromPrev === null ? "—" : s.transitionPctFromPrev.toFixed(1) + "%",
    "Ср.время (дн)": s.avgDaysFromPrev === null ? "—" : s.avgDaysFromPrev.toFixed(1),
  })));

  // Проверка монотонности.
  let mono = true;
  for (let i = 1; i < res.funnel.length; i++) {
    if (res.funnel[i].count > res.funnel[i - 1].count) {
      mono = false;
      console.log(`❌ НЕ монотонно: ${res.funnel[i].label} (${res.funnel[i].count}) > ${res.funnel[i - 1].label} (${res.funnel[i - 1].count})`);
    }
  }
  console.log(mono ? "\n✅ Воронка монотонна" : "\n❌ Нарушена монотонность");

  // Сверка с карточками: сумма target по всем когортам C1/C2/C5 за период.
  const coh = await computeCohorts({ from, to, maturity: "all", source: null, responsibleUserId: null });
  const sumTarget = (id: ConversionId) =>
    coh.cohorts.filter((c) => c.conversionId === id).reduce((a, c) => a + c.targetCount, 0);
  const stageCount = (key: string) => res.funnel.find((s) => s.key === key)?.count ?? 0;
  // Что показывает карточка C5 (matureBase / matureAvgPct).
  const c5 = coh.cohorts.filter((c) => c.conversionId === "C5");
  const c5m = c5.filter((c) => c.maturityState === "mature");
  const sum = (arr: typeof c5, k: "baseCount" | "targetCount") => arr.reduce((a, c) => a + c[k], 0);
  console.log("\n=== C5: что на карточке vs воронка ===");
  console.table([{
    "Карточка C5 — matureBase (лидов)": sum(c5m, "baseCount"),
    "matureTarget (гутшайнов в зрелых)": sum(c5m, "targetCount"),
    "allBase (Квал, все)": sum(c5, "baseCount"),
    "allTarget = воронка Гутшайн": sum(c5, "targetCount"),
    "Воронка Гутшайн": res.funnel.find((s) => s.key === "gutschein")?.count,
  }]);

  // matureBase («X лидов») по всем карточкам — ищем 128.
  console.log("\n=== matureBase (лидов) по карточкам — где 128? ===");
  console.table((["C1", "C2", "C3", "C4", "C5"] as ConversionId[]).map((id) => {
    const cc = coh.cohorts.filter((c) => c.conversionId === id);
    const cm = cc.filter((c) => c.maturityState === "mature");
    return {
      Карточка: id,
      "matureBase (лидов)": cm.reduce((a, c) => a + c.baseCount, 0),
      "matureTarget": cm.reduce((a, c) => a + c.targetCount, 0),
      "allTarget": cc.reduce((a, c) => a + c.targetCount, 0),
    };
  }));

  console.log("\n=== Воронка vs карточки (target-суммы) ===");
  console.table([
    { Веха: "Документы (C1)", Воронка: stageCount("docs"), "Карточка C1": sumTarget("C1"), Δ: stageCount("docs") - sumTarget("C1") },
    { Веха: "Термин ДЦ (C2)", Воронка: stageCount("term_dc"), "Карточка C1": sumTarget("C2"), Δ: stageCount("term_dc") - sumTarget("C2") },
    { Веха: "Гутшайн (C5)", Воронка: stageCount("gutschein"), "Карточка C1": sumTarget("C5"), Δ: stageCount("gutschein") - sumTarget("C5") },
  ]);
}

main().then(() => process.exit(0)).catch((e) => { console.error("fatal:", e); process.exit(1); });
