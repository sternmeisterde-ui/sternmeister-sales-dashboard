/**
 * Пере-синк зеркала `analytics.client_roleplays` из базы ОКК за период.
 *
 * Зачем: обычный ETL-тик берёт окно по `client_evaluations.created_at` — то
 * есть только СВЕЖИЕ оценки. Если строку в ОКК поправили задним числом (напр.
 * применили потолок балла через apply-limited-material-cap), её created_at не
 * менялся, тик её не подхватит, и вкладка «Ролевки» будет показывать старый
 * балл сколь угодно долго. Этот скрипт перечитывает окно целиком и переписывает
 * зеркало (ON CONFLICT DO UPDATE).
 *
 * ⚠ Только чтение ОКК + запись в зеркало. Kommo не трогает, Grok не зовёт.
 *
 *   npx tsx scripts/resync-client-roleplays.ts --from=2026-07-01 --to=2026-07-31
 */
import { config } from "dotenv";
import { resolve } from "node:path";
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

async function main() {
  const from = arg("from", "2026-07-01");
  const to = arg("to", "2026-07-31");
  const { syncClientRoleplays } = await import("../src/lib/etl/sync-client-roleplays");

  // Окно по created_at оценки: берём с запасом суток, чтобы захватить оценки,
  // посчитанные уже за полночь после позднего разговора.
  const fromDate = new Date(`${from}T00:00:00Z`);
  const toDate = new Date(`${to}T23:59:59Z`);
  console.log(`Пере-синк зеркала ролевок за ${from}..${to}…`);
  const n = await syncClientRoleplays(fromDate, toDate);
  console.log(`Перезаписано строк в зеркале: ${n}`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
