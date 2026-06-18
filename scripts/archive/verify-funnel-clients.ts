// READ-ONLY проверка computeClients (active + won) на реальных данных.
//   npx tsx scripts/verify-funnel-clients.ts
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { computeClients } from "../src/lib/funnel/clients";
import type { ClientGroup } from "../src/lib/funnel/clients";

function dumpGroup(title: string, g: ClientGroup): void {
  const cats: Record<string, number> = { hot: 0, warm: 0, cold: 0 };
  for (const c of g.clients) cats[c.category]++;
  const withRp = g.clients.filter(
    (c) => c.dc.attempts.length > 0 || c.aa.attempts.length > 0
  ).length;
  console.log(`\n=== ${title} === total=${g.total} shown=${g.shown}`);
  console.log("категории:", cats, "| с ролевками:", withRp);
  for (const c of g.clients.slice(0, 8)) {
    const dc = c.dc.attempts.length ? `[${c.dc.attempts.join("→")}]` : "—";
    const aa = c.aa.attempts.length ? `[${c.aa.attempts.join("→")}]` : "—";
    console.log(
      `  ${String(c.score).padStart(3)} ${c.category.padEnd(4)} | ` +
        `${c.name.slice(0, 20).padEnd(20)} | ${(c.status ?? "—").slice(0, 20).padEnd(20)} | ` +
        `${c.languageBucket.padEnd(4)} ДЦ=${dc} АА=${aa}`
    );
  }
}

async function main(): Promise<void> {
  // Дефолт вкладки: одна дата (сегодня) = термины с сегодня и дальше (открытый).
  const today = new Date().toISOString().slice(0, 10);
  const t0 = Date.now();
  const res = await computeClients({ terminFrom: today, terminTo: null }, 300);
  console.log(`termin >= ${today} (открытый) — готово за ${Date.now() - t0}ms`);
  dumpGroup("В РАБОТЕ", res.active);
  dumpGroup("ГУТШАЙН ОДОБРЕН", res.won);

  const first = res.active.clients[0];
  if (first) {
    console.log(`\nBreakdown «${first.name}» (score=${first.score}):`);
    for (const f of first.factors) {
      console.log(`  ${f.label.padEnd(24)} вес=${f.weight} value=${f.value}${f.present ? "" : " (нет данных)"}`);
    }
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error("fatal:", e); process.exit(1); });
