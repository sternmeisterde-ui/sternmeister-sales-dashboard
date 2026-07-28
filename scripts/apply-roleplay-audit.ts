// One-off applier для таблицы «Ролевки» (Воронка → Клиенты):
//   0035_client_roleplays_full_mirror — полное зеркало клиентских ролевок;
//   0036_leads_cohort_roleplay_slots  — колонка с ручными оценками из Kommo.
// Плюс полный ре-бэкфилл зеркала из D2 (теперь едут и звонки без ролевки).
//
// Идемпотентно: ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS, sync —
// ON CONFLICT DO UPDATE. Kommo не трогает (слоты — отдельным скриптом
// backfill-roleplay-slots.ts, он ходит в Kommo).
//
//   npx tsx scripts/apply-roleplay-audit.ts
import { config } from "dotenv";
import { resolve } from "node:path";
import dns from "node:dns";
import net from "node:net";

// standalone-скрипт не проходит через src/instrumentation.ts → Neon иначе
// виснет на AAAA там, где сломан IPv6.
dns.setDefaultResultOrder("ipv4first");
net.setDefaultAutoSelectFamily(true);
net.setDefaultAutoSelectFamilyAttemptTimeout(500);

config({ path: resolve(process.cwd(), ".env.local") });

import { sql } from "drizzle-orm";
import { analyticsDb } from "../src/lib/db/analytics";
import { syncClientRoleplays } from "../src/lib/etl/sync-client-roleplays";

async function main(): Promise<void> {
  console.log("=== 0035: analytics.client_roleplays — новые колонки ===");
  await analyticsDb.execute(sql`
    ALTER TABLE analytics.client_roleplays
      ADD COLUMN IF NOT EXISTS manager_conducted  BOOLEAN NOT NULL DEFAULT TRUE,
      ADD COLUMN IF NOT EXISTS roleplay_present   BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS manager_name       TEXT,
      ADD COLUMN IF NOT EXISTS prompt_type        TEXT,
      ADD COLUMN IF NOT EXISTS duration_seconds   INTEGER,
      ADD COLUMN IF NOT EXISTS question_coverage  JSONB`);
  await analyticsDb.execute(sql`
    UPDATE analytics.client_roleplays
       SET roleplay_present = (score_5 IS NOT NULL)
     WHERE roleplay_present = FALSE`);
  await analyticsDb.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_client_roleplays_conducted
      ON analytics.client_roleplays (lead_id, side)
      WHERE manager_conducted = TRUE`);
  console.log("  columns + index ready ✅");

  console.log("=== 0036: analytics.leads_cohort.roleplay_slots ===");
  await analyticsDb.execute(sql`
    ALTER TABLE analytics.leads_cohort
      ADD COLUMN IF NOT EXISTS roleplay_slots JSONB`);
  console.log("  column ready ✅");

  console.log("=== ре-бэкфилл зеркала из D2 (epoch → now) ===");
  const n = await syncClientRoleplays(new Date("2000-01-01T00:00:00Z"), new Date());
  console.log(`  upserted ${n} строк`);

  const r = await analyticsDb.execute<{
    total: string | number;
    conducted: string | number;
    scored: string | number;
    not_conducted: string | number;
  }>(sql`
    SELECT count(*)                                          AS total,
           count(*) FILTER (WHERE manager_conducted)          AS conducted,
           count(*) FILTER (WHERE score_5 IS NOT NULL)        AS scored,
           count(*) FILTER (WHERE NOT manager_conducted)      AS not_conducted
      FROM analytics.client_roleplays`);
  console.log("  analytics.client_roleplays:", r.rows[0]);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("fatal:", e);
    process.exit(1);
  });
