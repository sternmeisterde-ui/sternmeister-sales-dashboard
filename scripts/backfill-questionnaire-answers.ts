// Backfill leads_cohort.{start_date_answer,status_answer,income_answer}
// (ответы анкеты сайта: Kommo CFV 869932 START_DATE / 869936 STATUS /
// 869938 INCOME, сырой текст) для исторических b2b-лидов.
//
// Скоуп — лиды, созданные с 2026-01-01 (Berlin), обе b2b-воронки: ~9k id,
// пачками по 200 → ~45 запросов к Kommo, ≤1 rps. Более старые лиды по
// решению 2026-07-21 не трогаем; текущие дальше заполняет обычный sync-leads.
// Идемпотентно: перезаписывает колонки значением из Kommo (или NULL).
//
// Run from repo root:
//   npx tsx scripts/backfill-questionnaire-answers.ts            # dry-run (только счёт)
//   npx tsx scripts/backfill-questionnaire-answers.ts --apply    # записать в базу
//
// Requires .env.local: DATABASE_URL (kommo_tokens), ANALYTICS_DATABASE_URL.

import { setDefaultResultOrder } from "node:dns";
import { setDefaultAutoSelectFamily, setDefaultAutoSelectFamilyAttemptTimeout } from "node:net";
// Neon виснет на IPv6 — тот же фикс, что в src/instrumentation.ts
setDefaultResultOrder("ipv4first");
setDefaultAutoSelectFamily(true);
setDefaultAutoSelectFamilyAttemptTimeout(500);

import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

import { neon } from "@neondatabase/serverless";

const QS_FIELDS = {
  start_date_answer: 869932,
  status_answer: 869936,
  income_answer: 869938,
} as const;
const B2B_PIPELINE_IDS = [10631243, 13209983]; // Бух Комм, Мед Комм
// Начало 2026 по Berlin (UTC+1 зимой) — граница когорты бэкфилла.
const FROM_UTC = "2025-12-31T23:00:00Z";
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
      AND created_at >= ${FROM_UTC}
      AND lead_id IS NOT NULL
    ORDER BY lead_id`;
  const ids = candidates.map((r) => Number(r.lead_id));
  console.log(`Кандидатов (b2b, created_at ≥ 2026-01-01 Berlin): ${ids.length}; режим: ${apply ? "APPLY" : "dry-run"}`);

  let withAnyAnswer = 0;
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
      const val = (fieldId: number): string | null => {
        const f = lead.custom_fields_values?.find((x) => x.field_id === fieldId);
        const v = f?.values?.[0]?.value;
        return typeof v === "string" && v.trim() ? v.trim() : null;
      };
      const startDate = val(QS_FIELDS.start_date_answer);
      const status = val(QS_FIELDS.status_answer);
      const income = val(QS_FIELDS.income_answer);
      if (startDate === null && status === null && income === null) continue;
      withAnyAnswer++;
      if (apply) {
        await an`
          UPDATE analytics.leads_cohort
          SET start_date_answer = ${startDate},
              status_answer = ${status},
              income_answer = ${income}
          WHERE lead_id = ${lead.id}`;
        updated++;
      }
    }
    console.log(`  ${Math.min(i + CHUNK, ids.length)}/${ids.length} обработано (ответы найдены у ${withAnyAnswer})`);
    if (i + CHUNK < ids.length) await sleep(RATE_MS);
  }

  console.log(`Готово: ответы анкеты найдены у ${withAnyAnswer} лидов${apply ? `, обновлено строк: ${updated}` : " (dry-run, база не тронута)"}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
