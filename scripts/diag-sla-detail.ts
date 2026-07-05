// Сверка SLA drill-down: среднее по детализации == плитке; ФИ заполняются.
// Также ФИ в детализации «Потерянных». READ-ONLY.
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });
import dns from "node:dns";
dns.setDefaultResultOrder("ipv4first");
import {
  getAnalyticsSlaFirstCallMinutes,
  getAnalyticsSlaLeadsDetail,
  getAnalyticsLostCallsDetail,
} from "../src/lib/daily/analytics-calls";
import { getManagersWithKommo } from "../src/lib/db/queries-daily";
import { parseDateBoundary } from "../src/lib/utils/date";

async function main() {
  const ymd = process.argv[2] ?? "2026-06-29";
  const from = Math.floor(parseDateBoundary(ymd, "start")!.getTime() / 1000);
  const to = Math.floor(parseDateBoundary(ymd, "end")!.getTime() / 1000);

  const [tile, detail] = await Promise.all([
    getAnalyticsSlaFirstCallMinutes("b2b", from, to),
    getAnalyticsSlaLeadsDetail("b2b", from, to),
  ]);
  const avg = detail.length ? Math.round(detail.reduce((s, x) => s + x.slaMinutes, 0) / detail.length) : 0;
  console.log(`${ymd}: плитка SLA=${tile}м, детализация: n=${detail.length}, ср.=${avg}м ${Math.abs(tile - avg) <= 1 ? "✓" : "✗ РАСХОЖДЕНИЕ"}`);
  const withName = detail.filter((d) => d.clientName).length;
  console.log(`  ФИ заполнено: ${withName}/${detail.length}; примеры:`);
  for (const d of detail.slice(0, 3)) console.log("   ", JSON.stringify(d));

  const roster = await getManagersWithKommo("b2b");
  const lost = await getAnalyticsLostCallsDetail(roster, "b2b", from, to);
  const lostWithName = lost.filter((d) => d.clientName).length;
  console.log(`\nПотерянные: n=${lost.length}, ФИ заполнено: ${lostWithName}/${lost.length}; пример:`, JSON.stringify(lost[0] ?? null));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
