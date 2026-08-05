// Удаление одной строки из D1 daily_plans по id.
//
// Зачем: тестовый ввод плана мог сохраниться в неверной шкале (напр.
// «Всего лидов план» 14/месяц от 2026-08-05 — до фикса масштабирования
// ввода) и, пока строка существует, блокирует дефолт из
// B2G_DAILY_PLAN_DEFAULTS (metrics-config.ts). Дефолт применяется только
// при полном отсутствии записи.
//
// Запуск из корня репозитория:
//   npx tsx scripts/delete-daily-plan-row.ts --id 16511          # dry-run
//   npx tsx scripts/delete-daily-plan-row.ts --id 16511 --apply
//
// Требует .env.local: DATABASE_URL (D1).
import { config } from "dotenv";
import { resolve } from "node:path";
import dns from "node:dns";
import net from "node:net";

// IPv4-first как в src/instrumentation.ts (см. memory neon-ipv6-hang).
dns.setDefaultResultOrder("ipv4first");
net.setDefaultAutoSelectFamily(true);
net.setDefaultAutoSelectFamilyAttemptTimeout(500);

config({ path: resolve(process.cwd(), ".env.local") });

import { neon } from "@neondatabase/serverless";

const args = process.argv.slice(2);
const argOf = (flag: string): string | null => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : null;
};
const APPLY = args.includes("--apply");
const ID = Number(argOf("--id"));

async function main() {
  if (!Number.isInteger(ID) || ID <= 0) {
    console.error("Usage: npx tsx scripts/delete-daily-plan-row.ts --id <daily_plans.id> [--apply]");
    process.exit(1);
  }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set (.env.local)");
  const sql = neon(url);

  const rows = await sql`
    SELECT id, department, vertical, line, user_id, metric_key, plan_value, period_type, period_date, updated_at
    FROM daily_plans WHERE id = ${ID}`;
  if (rows.length === 0) {
    console.log(`Строка id=${ID} не найдена — нечего удалять.`);
    return;
  }
  console.log("Найдена строка:", JSON.stringify(rows[0], null, 2));

  if (!APPLY) {
    console.log("Dry-run: ничего не удалено. Добавьте --apply для удаления.");
    return;
  }
  const del = await sql`DELETE FROM daily_plans WHERE id = ${ID} RETURNING id`;
  console.log(`Удалено строк: ${del.length} (id=${ID}).`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
