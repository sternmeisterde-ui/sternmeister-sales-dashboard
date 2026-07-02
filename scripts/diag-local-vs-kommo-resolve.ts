// Валидация local-first enrichment: на выборке телефонов из бэклога
// сравниваем резолв через зеркало (contacts+links) и через Kommo.
// Сравнение и «сырых» множеств lead_ids, и «эффективных» (∩ leads_cohort —
// только они влияют на enrichment). Kommo-запросов: = размеру выборки,
// темп ограничен KOMMO_RATE_LIMIT_MS. READ-ONLY.
//
// Usage: KOMMO_RATE_LIMIT_MS=2500 npx tsx scripts/diag-local-vs-kommo-resolve.ts [n=40]

import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });
import dns from "node:dns";
dns.setDefaultResultOrder("ipv4first");
import { neon } from "@neondatabase/serverless";
import { resolvePhonesLocally } from "../src/lib/etl/enrich-telephony-leads";
import { searchContactsByPhone } from "../src/lib/kommo/client";

async function main() {
  const n = Number(process.argv[2] ?? 40);
  const adb = neon(process.env.ANALYTICS_DATABASE_URL!);

  const sample = (await adb`
    SELECT DISTINCT phone FROM analytics.communications
    WHERE lead_id IS NULL AND phone IS NOT NULL AND phone <> ''
      AND communication_type LIKE 'call%'
      AND created_at >= '2026-06-01'
      AND NOT EXISTS (SELECT 1 FROM analytics.enrich_skip_phones s WHERE s.phone = communications.phone)
    ORDER BY phone
    LIMIT ${n}`) as Array<{ phone: string }>;
  const phones = sample.map((r) => r.phone);
  console.log(`Выборка: ${phones.length} телефонов из бэклога`);

  const [localMap, kommoMap] = [await resolvePhonesLocally(phones), await searchContactsByPhone(phones)];

  // Эффективный фильтр: только лиды, существующие в leads_cohort.
  const allIds = new Set<number>();
  for (const m of [localMap, kommoMap]) for (const ids of m.values()) for (const id of ids) allIds.add(id);
  const known = new Set<number>();
  if (allIds.size > 0) {
    const rows = (await adb`
      SELECT lead_id FROM analytics.leads_cohort WHERE lead_id = ANY(${[...allIds]})`) as Array<{ lead_id: string | number }>;
    for (const r of rows) known.add(Number(r.lead_id));
  }

  let same = 0, sameEff = 0, diff = 0;
  for (const p of phones) {
    const l = new Set((localMap.get(p) ?? []).map(Number));
    const k = new Set((kommoMap.get(p) ?? []).map(Number));
    const eq = l.size === k.size && [...l].every((x) => k.has(x));
    const le = new Set([...l].filter((x) => known.has(x)));
    const ke = new Set([...k].filter((x) => known.has(x)));
    const eqEff = le.size === ke.size && [...le].every((x) => ke.has(x));
    if (eq) same++;
    if (eqEff) sameEff++;
    else {
      diff++;
      console.log(`  РАЗЛИЧИЕ ${p}: local=[${[...le].join(",")}] kommo=[${[...ke].join(",")}] (raw: ${[...l].join(",")} vs ${[...k].join(",")})`);
    }
  }
  console.log(`\nИтог: сырое совпадение ${same}/${phones.length}, эффективное (∩ leads_cohort) ${sameEff}/${phones.length}, различий ${diff}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
