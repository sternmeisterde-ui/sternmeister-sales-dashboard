// READ-ONLY проверка хелпера src/lib/funnel/roleplays.ts на реальных данных.
// Берёт лидов с несколькими попытками (для динамики) + пару одиночных,
// прогоняет через getRoleplaysForLeads, печатает готовность по сторонам.
//   npx tsx scripts/verify-funnel-roleplays.ts
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { sql } from "drizzle-orm";
import { analyticsDb } from "../src/lib/db/analytics";
import { getRoleplaysForLeads } from "../src/lib/funnel/roleplays";

async function main(): Promise<void> {
  // Лиды с >1 ролевкой (динамика), затем добиваем одиночными до ~6.
  const multi = await analyticsDb.execute<{ lead_id: string }>(sql`
    SELECT lead_id FROM analytics.client_roleplays
    GROUP BY lead_id HAVING count(*) > 1 ORDER BY lead_id LIMIT 5
  `);
  const some = await analyticsDb.execute<{ lead_id: string }>(sql`
    SELECT lead_id FROM analytics.client_roleplays
    GROUP BY lead_id HAVING count(*) = 1 ORDER BY max(roleplay_at) DESC LIMIT 4
  `);
  const ids = [
    ...multi.rows.map((r) => Number(r.lead_id)),
    ...some.rows.map((r) => Number(r.lead_id)),
  ];
  console.log("Проверяем lead_ids:", ids);

  const map = await getRoleplaysForLeads(ids);
  console.log(`\nХелпер вернул ${map.size} лидов с ролевками.\n`);

  for (const id of ids) {
    const lr = map.get(id);
    if (!lr) {
      console.log(`lead ${id}: нет ролевок`);
      continue;
    }
    const fmtSide = (label: string, s: typeof lr.dc) =>
      s.count === 0
        ? `${label}: —`
        : `${label}: latest=${s.latestScore5} avg=${s.avgScore5} best=${s.bestScore5} ` +
          `динамика=[${s.attempts.map((a) => a.score5 ?? "·").join("→")}] (n=${s.count})`;
    console.log(`lead ${id}`);
    console.log("  " + fmtSide("ДЦ", lr.dc));
    console.log("  " + fmtSide("АА", lr.aa));
  }

  // Негативный кейс: несуществующий лид → не должен падать.
  const none = await getRoleplaysForLeads([1]);
  console.log(`\nНесуществующий lead [1]: вернулось ${none.size} (ожидаем 0) ✅`);
}

main().then(() => process.exit(0)).catch((e) => { console.error("fatal:", e); process.exit(1); });
