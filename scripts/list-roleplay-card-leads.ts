/**
 * Список сделок, чьи карточки надо свести с данными бота за период.
 *
 * Берём объединение двух множеств:
 *   • у кого в зеркале карточки (leads_cohort.roleplay_slots) есть слот с датой
 *     внутри окна — там может стоять ручная цифра без разбора;
 *   • у кого бот разобрал ролевку внутри окна (analytics.client_roleplays) —
 *     его балл должен оказаться в слоте.
 *
 * ⚠ Только чтение. Kommo не трогает. Результат скармливается ОКК:
 *   npx tsx scripts/reconcile-roleplay-slots.ts --leads-file=leads.txt --from=... --to=...
 *
 *   npx tsx scripts/list-roleplay-card-leads.ts --from=2026-07-01 --to=2026-07-29 --out=leads.txt
 */
import { config } from "dotenv";
import { resolve } from "node:path";
import { writeFileSync } from "node:fs";
import dns from "node:dns";
import net from "node:net";

dns.setDefaultResultOrder("ipv4first");
net.setDefaultAutoSelectFamily(true);
net.setDefaultAutoSelectFamilyAttemptTimeout(500);

config({ path: resolve(process.cwd(), ".env.local") });

const args = process.argv.slice(2);
const arg = (k: string, d: string) => {
  const a = args.find((x) => x.startsWith(`--${k}=`));
  return a ? a.slice(k.length + 3) : d;
};
const FROM = arg("from", "2026-07-01");
const TO = arg("to", "2026-07-29");
const OUT = arg("out", "");
const VERTICAL = arg("vertical", "buh") as "buh" | "med" | "all";

async function main() {
  const { sql } = await import("drizzle-orm");
  const { analyticsDb } = await import("../src/lib/db/analytics");
  const { getBeraterPipelineIds } = await import("../src/lib/kommo/pipeline-config");
  const rows = (r: any) => (Array.isArray(r) ? r : r.rows) as any[];
  const beraterIds = getBeraterPipelineIds(VERTICAL);

  // Слоты с датой внутри окна. roleplay_slots = NULL значит «сделку не синкали»
  // (см. docs), такие не берём — про их карточку мы ничего не знаем.
  const withSlots = rows(await analyticsDb.execute(sql`
    SELECT DISTINCT lc.lead_id, s->>'side' AS side
    FROM analytics.leads_cohort lc,
         LATERAL jsonb_array_elements(lc.roleplay_slots) AS s
    WHERE lc.roleplay_slots IS NOT NULL
      AND lc.pipeline_id IN (${sql.join(beraterIds.map((id) => sql`${id}`), sql`, `)})
      AND lc.is_deleted = FALSE
      AND (s->>'date') BETWEEN ${FROM} AND ${TO}
  `));

  // Разборы бота берём ИЗ D2 НАПРЯМУЮ, а не из зеркала analytics: зеркало
  // обновляет ETL, и сразу после добора оно отстаёт — свежие ролевки в список
  // не попали бы, а именно их и надо разложить по слотам.
  const { d2OkkDb } = await import("../src/lib/db/okk");
  const withBot = rows(await d2OkkDb.execute(sql`
    SELECT DISTINCT c.kommo_lead_id AS lead_id, ce.side AS side
    FROM client_evaluations ce
    JOIN calls c ON c.id = ce.call_id
    WHERE c.kommo_lead_id IS NOT NULL
      AND ((c.call_created_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Berlin')::date
            BETWEEN ${FROM}::date AND ${TO}::date
  `));

  // Пишем «сделка,стороны» — сверке незачем читать карточку по стороне, на
  // которой заведомо ничего нет: каждое лишнее чтение это ещё запрос к Kommo.
  const sides = new Map<string, Set<string>>();
  for (const r of [...withSlots, ...withBot]) {
    const lead = String(r.lead_id);
    const side = String(r.side ?? "");
    if (side !== "dc" && side !== "aa") continue;
    const set = sides.get(lead) ?? new Set<string>();
    set.add(side);
    sides.set(lead, set);
  }
  const all = [...sides.keys()].sort();
  const pairs = [...sides.values()].reduce((n, s) => n + s.size, 0);
  console.log(`окно ${FROM}..${TO}`);
  console.log(`  со слотами в карточке: ${new Set(withSlots.map((r) => String(r.lead_id))).size}`);
  console.log(`  с разбором бота:       ${new Set(withBot.map((r) => String(r.lead_id))).size}`);
  console.log(`  всего к сверке:        ${all.length} сделок / ${pairs} сторон`);

  if (OUT) {
    writeFileSync(OUT, all.map((l) => `${l},${[...sides.get(l)!].sort().join("|")}`).join("\n") + "\n", "utf-8");
    console.log(`\nЗаписано в ${OUT}`);
  } else {
    console.log("\n(--out=файл не задан — список не сохранён)");
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
