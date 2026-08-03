// One-off applier для 0037_sla_first_call_manager.
// Добавляет analytics.sla.first_call_manager (ADD COLUMN IF NOT EXISTS —
// идемпотентно) + комментарий. ОБЯЗАТЕЛЬНО применить ДО деплоя кода: с этого
// релиза compute-sla пишет колонку, и без неё вставка SLA падает у обоих отделов.
//
//   npx tsx scripts/apply-sla-first-call-manager.ts
//
// Requires .env.local: ANALYTICS_DATABASE_URL.

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

async function main(): Promise<void> {
  console.log("=== 0037_sla_first_call_manager ===");
  await analyticsDb.execute(sql`
    ALTER TABLE analytics.sla
      ADD COLUMN IF NOT EXISTS first_call_manager text
  `);
  await analyticsDb.execute(sql`
    COMMENT ON COLUMN analytics.sla.first_call_manager IS
      'Автор ПЕРВОГО исходящего звонка по лиду (analytics.communications.manager). Кому засчитывается «своё» SLA Госников — в Kommo ответственным за свежий лид стоит РОП, поэтому по нему считать нельзя. NULL = звонка не было.'
  `);

  const check = await (analyticsDb as unknown as {
    execute: <T>(q: unknown) => Promise<{ rows: T[] }>;
  }).execute<{ column_name: string; data_type: string }>(sql`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_schema = 'analytics' AND table_name = 'sla'
      AND column_name = 'first_call_manager'
  `);
  console.log("Проверка:", check.rows.length === 1 ? "колонка на месте" : "КОЛОНКИ НЕТ", check.rows);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("Ошибка:", e);
    process.exit(1);
  });
