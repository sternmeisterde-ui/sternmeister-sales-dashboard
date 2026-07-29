// Разовый backfill `analytics.leads_cohort.roleplay_slots` (миграция 0036).
//
// Зачем отдельно: инкрементальный sync-leads обновляет только сделки, у которых
// поменялся updated_at. Ролевочные поля Kommo проставлены задним числом, поэтому
// исторические сделки иначе останутся с roleplay_slots = NULL.
//
// ⚠ ХОДИТ В KOMMO. Тянет ТОЛЬКО Бератер-воронки (bуx + мед), постранично по 250
// через штатный rate-limiter клиента. Порядок ~15–25 запросов на всю историю.
// Запускать по согласованию и не параллельно с другими Kommo-скриптами
// (лимит общий на аккаунт, рядом работает прод-крон).
//
// Пишет ТОЛЬКО колонку roleplay_slots (UPDATE), остальные поля сделки не
// трогает — не конфликтует с DELETE+INSERT логикой sync-leads.
//
//   npx tsx scripts/backfill-roleplay-slots.ts
import { config } from "dotenv";
import { resolve } from "node:path";
import dns from "node:dns";
import net from "node:net";

dns.setDefaultResultOrder("ipv4first");
net.setDefaultAutoSelectFamily(true);
net.setDefaultAutoSelectFamilyAttemptTimeout(500);

config({ path: resolve(process.cwd(), ".env.local") });

import { sql } from "drizzle-orm";
import { analyticsDb } from "../src/lib/db/analytics";
import { getAuthHeaders, getBaseUrl, getLeads, rateLimitedFetch } from "../src/lib/kommo/client";
import { getBeraterPipelineIds } from "../src/lib/kommo/pipeline-config";
import { parseRoleplaySlotsFromLead } from "../src/lib/etl/sync-leads";

/**
 * Точечный режим: `--from=YYYY-MM-DD --to=YYYY-MM-DD`.
 *
 * Берём только сделки, по которым в периоде есть разбор ролевок, и тянем их
 * строго по id пачками. Для месяца это единицы запросов вместо полного обхода
 * воронки — так сверку «бот ↔ карточка» можно наполнить, не гоняя всю историю
 * рядом с прод-кроном.
 */
const ID_BATCH = 50; // Kommo режет длину URL раньше формального лимита в 250

async function backfillByRange(from: string, to: string): Promise<void> {
  const res = await analyticsDb.execute(sql`
    SELECT DISTINCT cr.lead_id AS id
    FROM analytics.client_roleplays cr
    JOIN analytics.leads_cohort lc ON lc.lead_id = cr.lead_id
    WHERE ((cr.roleplay_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Berlin')::date
            BETWEEN ${from}::date AND ${to}::date
      AND lc.is_deleted = FALSE`);
  const ids = ((res as unknown as { rows: Array<{ id: number }> }).rows ?? []).map((r) => Number(r.id));
  const requests = Math.ceil(ids.length / ID_BATCH);
  console.log(`=== точечный добор ${from}..${to}: сделок ${ids.length}, запросов к Kommo ${requests} ===`);
  if (ids.length === 0) return;

  const headers = await getAuthHeaders();
  const base = await getBaseUrl();
  let updated = 0;
  let withSlots = 0;

  for (let i = 0; i < ids.length; i += ID_BATCH) {
    const batch = ids.slice(i, i + ID_BATCH);
    const url = new URL(`${base}/leads`); // getBaseUrl уже содержит /api/v4
    batch.forEach((id) => url.searchParams.append("filter[id][]", String(id)));
    url.searchParams.set("limit", String(ID_BATCH));

    const r = await rateLimitedFetch(url.toString(), { headers });
    if (r.status === 204) continue; // так Kommo отвечает на пустую выборку
    if (!r.ok) throw new Error(`Kommo ${r.status} на пачке ${i / ID_BATCH + 1}`);

    const json = (await r.json()) as {
      _embedded?: { leads?: Array<{ id: number; custom_fields_values: unknown }> };
    };
    for (const lead of json._embedded?.leads ?? []) {
      const slots = parseRoleplaySlotsFromLead(
        lead.custom_fields_values as Parameters<typeof parseRoleplaySlotsFromLead>[0],
      );
      await analyticsDb.execute(sql`
        UPDATE analytics.leads_cohort
           SET roleplay_slots = ${JSON.stringify(slots)}::jsonb
         WHERE lead_id = ${lead.id}`);
      updated++;
      if (slots.length > 0) withSlots++;
    }
    console.log(`  пачка ${Math.floor(i / ID_BATCH) + 1}/${requests}: обновлено ${updated}`);
  }
  console.log(`\nDone: обновлено ${updated}, из них со слотами ${withSlots} ✅`);
}

async function main(): Promise<void> {
  const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? null;
  const from = arg("from");
  const to = arg("to");
  if (from && to) {
    await backfillByRange(from, to);
    return;
  }

  const pipelines = getBeraterPipelineIds("all"); // бух + мед Бератер
  console.log(`=== backfill roleplay_slots (pipelines ${pipelines.join(", ")}) ===`);

  // maxPages с запасом: 250 сделок/страница; Бератер-воронки исторически ~5k.
  const leads = await getLeads(pipelines, undefined, 40);
  console.log(`  получено сделок из Kommo: ${leads.length}`);

  let withSlots = 0;
  let updated = 0;
  const CHUNK = 200;
  const rows: Array<{ leadId: number; json: string }> = [];

  for (const lead of leads) {
    // [] тоже пишем: пустой массив = «синкали, слотов нет», NULL = «не синкали».
    const slots = parseRoleplaySlotsFromLead(lead.custom_fields_values ?? null);
    if (slots.length > 0) withSlots++;
    rows.push({ leadId: lead.id, json: JSON.stringify(slots) });
  }
  console.log(`  из них с заполненными слотами: ${withSlots}`);

  for (let i = 0; i < rows.length; i += CHUNK) {
    for (const r of rows.slice(i, i + CHUNK)) {
      await analyticsDb.execute(sql`
        UPDATE analytics.leads_cohort
           SET roleplay_slots = ${r.json}::jsonb
         WHERE lead_id = ${r.leadId}`);
      updated++;
    }
    console.log(`  обновлено ${Math.min(i + CHUNK, rows.length)}/${rows.length}`);
  }

  const check = await analyticsDb.execute<{ filled: string | number }>(sql`
    SELECT count(*) AS filled
      FROM analytics.leads_cohort
     WHERE roleplay_slots IS NOT NULL`);
  console.log(`\nDone: обновлено строк ${updated}; со слотами в БД: ${check.rows[0]?.filled} ✅`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("fatal:", e);
    process.exit(1);
  });
