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
import { getLeads } from "../src/lib/kommo/client";
import { getBeraterPipelineIds } from "../src/lib/kommo/pipeline-config";
import { parseRoleplaySlotsFromLead } from "../src/lib/etl/sync-leads";

async function main(): Promise<void> {
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
