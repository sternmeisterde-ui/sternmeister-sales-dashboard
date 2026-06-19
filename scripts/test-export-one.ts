// E2E-проверка выгрузки на ОДНОМ реальном лиде, без таблицы-очереди.
// Прогоняет реальный код exportContactCalls() → создаёт папку на Drive с аудио
// и транскриптами. По умолчанию lead 19587126 (контакт «Наталья» из Фазы 0).
//
//   npx tsx scripts/test-export-one.ts            # дефолтный лид
//   npx tsx scripts/test-export-one.ts 19794500   # другой лид

import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });
import net from "node:net";
import dns from "node:dns";
net.setDefaultAutoSelectFamily(false); // Windows-воркэраунд IPv6 (см. диагностику)
dns.setDefaultResultOrder("ipv4first");

import { sql } from "drizzle-orm";
import { analyticsDb } from "../src/lib/db/analytics";
import { exportContactCalls, type ExportRow } from "../src/lib/exports/process-export";
import { APP_TZ } from "../src/lib/utils/date";

async function main() {
  const leadId = Number(process.argv[2] ?? 19587126);
  console.log("Лид:", leadId);

  const res = await analyticsDb.execute<ExportRow>(sql`
    SELECT DISTINCT ON (lc.lead_id)
      lc.lead_id, ct.contact_id, ct.name AS contact_name,
      to_char(((COALESCE(lc.first_payment_date, lc.prepayment_date, lc.closed_at, lc.updated_at)
        AT TIME ZONE 'UTC') AT TIME ZONE ${APP_TZ}), 'YYYY-MM-DD') AS payment_date
    FROM analytics.leads_cohort lc
    JOIN analytics.lead_contact_links lcl ON lcl.lead_id = lc.lead_id AND lcl.is_active = true
    JOIN analytics.contacts ct ON ct.contact_id = lcl.contact_id
    WHERE lc.lead_id = ${leadId}
    ORDER BY lc.lead_id, lcl.first_seen_at ASC
    LIMIT 1
  `);
  const row = res.rows[0];
  if (!row) { console.log("Лид/контакт не найден."); return; }
  console.log("Контакт:", row.contact_name, "| дата оплаты:", row.payment_date);

  console.log("\nЗапускаю exportContactCalls()…");
  const out = await exportContactCalls(row);
  console.log("\n✅ Готово:");
  console.log("   звонков найдено:", out.callCount);
  console.log("   залито записей: ", out.uploaded);
  console.log("   папка:          https://drive.google.com/drive/folders/" + out.folderId);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error("\n❌ Упало:", e instanceof Error ? e.stack : e);
  process.exit(1);
});
