// Backfill leads_cohort.first_payment_fact_date (Kommo CFV 888296
// «Факт. Дата 1-го платежа») для исторических лидов.
//
// Прогон точечный: строгий факт может быть только у лидов, где смешанная
// first_payment_date уже непустая (факт входит в её алиасы) — таких ~505 на
// весь b2b. Тянем их из Kommo пачками по 200 id (≈3–5 запросов, 1 rps),
// идемпотентно перезаписываем колонку. Полный проход по Kommo НЕ нужен:
// текущие лиды дальше заполняет обычный sync-leads.
//
// Run from repo root:
//   npx tsx scripts/backfill-first-payment-fact.ts            # dry-run (только счёт)
//   npx tsx scripts/backfill-first-payment-fact.ts --apply    # записать в базу
//
// Requires .env.local: DATABASE_URL (kommo_tokens), ANALYTICS_DATABASE_URL.

import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

import { neon } from "@neondatabase/serverless";

const FIRST_PAYMENT_FACT_FIELD_ID = 888296;
const B2B_PIPELINE_IDS = [10631243, 13209983]; // Бух Комм, Мед Комм
const CHUNK = 200; // id за запрос (лимит страницы Kommo — 250)
const RATE_MS = 1100; // ≤1 rps — правило проекта

const apply = process.argv.includes("--apply");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const d1 = neon(process.env.DATABASE_URL!);
  const an = neon(process.env.ANALYTICS_DATABASE_URL!);

  // Боевой access token живёт в D1.kommo_tokens (KOMMO_TOKEN_SOURCE=db).
  const tok = await d1`SELECT access_token FROM kommo_tokens ORDER BY updated_at DESC LIMIT 1`;
  const token = tok[0]?.access_token as string | undefined;
  if (!token) throw new Error("Нет access_token в kommo_tokens (D1)");
  const base = `https://${process.env.KOMMO_API_DOMAIN || "sternmeister.kommo.com"}`;

  const candidates = await an`
    SELECT lead_id FROM analytics.leads_cohort
    WHERE pipeline_id = ANY(${B2B_PIPELINE_IDS})
      AND first_payment_date IS NOT NULL
      AND lead_id IS NOT NULL
    ORDER BY lead_id`;
  const ids = candidates.map((r) => Number(r.lead_id));
  console.log(`Кандидатов (first_payment_date IS NOT NULL): ${ids.length}; режим: ${apply ? "APPLY" : "dry-run"}`);

  let withFact = 0;
  let updated = 0;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const params = new URLSearchParams({ limit: "250", with: "" });
    for (const id of slice) params.append("filter[id][]", String(id));
    const res = await fetch(`${base}/api/v4/leads?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`Kommo HTTP ${res.status}`);
    const j = (await res.json()) as {
      _embedded?: { leads?: Array<{ id: number; custom_fields_values: Array<{ field_id: number; values: Array<{ value: unknown }> }> | null }> };
    };
    const leads = j._embedded?.leads ?? [];

    for (const lead of leads) {
      const f = lead.custom_fields_values?.find((x) => x.field_id === FIRST_PAYMENT_FACT_FIELD_ID);
      const raw = f?.values?.[0]?.value;
      if (raw == null) continue; // факта нет — колонка остаётся NULL
      // Kommo date CFV = unix seconds (number или numeric string)
      const ts = typeof raw === "number" ? raw : Number(raw);
      if (!Number.isFinite(ts) || ts <= 0) continue;
      const date = new Date(ts * 1000);
      withFact++;
      if (apply) {
        await an`
          UPDATE analytics.leads_cohort
          SET first_payment_fact_date = ${date}
          WHERE lead_id = ${lead.id}`;
        updated++;
      }
    }
    console.log(`  ${Math.min(i + CHUNK, ids.length)}/${ids.length} обработано (fact найден у ${withFact})`);
    if (i + CHUNK < ids.length) await sleep(RATE_MS);
  }

  console.log(`Готово: факт-дата найдена у ${withFact} лидов${apply ? `, обновлено строк: ${updated}` : " (dry-run, база не тронута)"}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
