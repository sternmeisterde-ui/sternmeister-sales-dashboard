/**
 * Убирает из зеркала `analytics.client_roleplays` строки, которых больше нет в
 * источнике (D2 `client_evaluations`).
 *
 * Зачем: синк зеркала (sync-client-roleplays) только дописывает — ON CONFLICT
 * DO UPDATE. Удаление в ОКК до аналитики не доезжает, и удалённая ролевка
 * остаётся в разделе «Ролевки» навсегда. Первый случай — уборка 29.07.2026:
 * 62 ролевки, ошибочно посчитанные по звонкам не-бератеров, удалили в ОКК, а
 * во вкладке они продолжали висеть.
 *
 * ⚠ Только чтение источника + удаление в зеркале. Kommo не трогает.
 *
 *   DRY:   npx tsx scripts/purge-orphan-client-roleplays.ts --from=2026-07-01 --to=2026-07-31
 *   APPLY: то же + --apply
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
const apply = args.includes("--apply");
const arg = (k: string, d: string) => {
  const a = args.find((x) => x.startsWith(`--${k}=`));
  return a ? a.slice(k.length + 3) : d;
};

async function main() {
  const from = arg("from", "2026-07-01");
  const to = arg("to", "2026-07-31");
  const { sql } = await import("drizzle-orm");
  const { analyticsDb } = await import("../src/lib/db/analytics");
  const { d2OkkDb } = await import("../src/lib/db/okk");
  const rows = (r: any) => (Array.isArray(r) ? r : r.rows) as any[];

  // Источник: какие звонки реально имеют оценку клиента в окне.
  const live = new Set(
    rows(await d2OkkDb.execute(sql`
      SELECT ce.call_id FROM client_evaluations ce
      JOIN calls c ON c.id = ce.call_id
      WHERE ((c.call_created_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Berlin')::date
              BETWEEN ${from}::date AND ${to}::date
    `)).map((r) => String(r.call_id)),
  );

  const mirror = rows(await analyticsDb.execute(sql`
    SELECT okk_call_id, lead_id, manager_name, side, score_5,
           ((roleplay_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Berlin')::date::text AS day
    FROM analytics.client_roleplays
    WHERE ((roleplay_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Berlin')::date
            BETWEEN ${from}::date AND ${to}::date
  `));

  const orphans = mirror.filter((r) => !live.has(String(r.okk_call_id)));
  console.log(`Окно ${from}..${to}: в зеркале ${mirror.length}, в источнике ${live.size}, осиротевших ${orphans.length}`);
  const byMgr = new Map<string, number>();
  for (const o of orphans) byMgr.set(o.manager_name ?? "—", (byMgr.get(o.manager_name ?? "—") ?? 0) + 1);
  if (orphans.length) console.log("по менеджерам:", Object.fromEntries([...byMgr].sort((a, b) => b[1] - a[1])));

  if (!orphans.length) return;
  if (!apply) {
    console.log("\nХОЛОСТОЙ ПРОГОН. Добавьте --apply, чтобы удалить.\n");
    return;
  }
  await analyticsDb.execute(sql`
    DELETE FROM analytics.client_roleplays
    WHERE okk_call_id IN (${sql.join(orphans.map((o) => sql`${String(o.okk_call_id)}`), sql`, `)})
  `);
  console.log(`\nУдалено из зеркала: ${orphans.length}\n`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
