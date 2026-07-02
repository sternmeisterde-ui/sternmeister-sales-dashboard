// Проверка drill-down «Потерянных»: счётчик плитки vs длина детализации
// должны совпадать (одинаковые условия отбора). READ-ONLY.
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });
import dns from "node:dns";
dns.setDefaultResultOrder("ipv4first");
import { getAnalyticsLostCalls, getAnalyticsLostCallsDetail } from "../src/lib/daily/analytics-calls";
import { getManagersWithKommo } from "../src/lib/db/queries-daily";
import { parseDateBoundary } from "../src/lib/utils/date";

async function main() {
  const ymd = process.argv[2] ?? "2026-06-30";
  const from = Math.floor(parseDateBoundary(ymd, "start")!.getTime() / 1000);
  const to = Math.floor(parseDateBoundary(ymd, "end")!.getTime() / 1000);

  const roster = await getManagersWithKommo("b2b");
  const [count, detail] = await Promise.all([
    getAnalyticsLostCalls(roster, "b2b", from, to),
    getAnalyticsLostCallsDetail(roster, "b2b", from, to),
  ]);
  console.log(`${ymd}: плитка=${count}, детализация=${detail.length} ${count === detail.length ? "✓ СОШЛОСЬ" : "✗ РАСХОЖДЕНИЕ!"}`);
  const byMgr = new Map<string, number>();
  for (const d of detail) byMgr.set(d.manager ?? "Без менеджера", (byMgr.get(d.manager ?? "Без менеджера") ?? 0) + 1);
  for (const [m, n] of [...byMgr.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${m}: ${n}`);
  console.log("Примеры:", JSON.stringify(detail.slice(0, 3), null, 2));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
