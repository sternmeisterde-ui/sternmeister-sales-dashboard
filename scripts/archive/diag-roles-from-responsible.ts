// Проверка гипотезы: роль менеджера на сделке выводится из «ответственный по
// воронке» + «линия менеджера» — без импорта редких текстовых CRM-полей (WP1).
// ТОЛЬКО ЧТЕНИЕ. Кросс-БД (Analytics + D2), join в JS.
//
//   npx tsx scripts/diag-roles-from-responsible.ts

import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

import { sql } from "drizzle-orm";
import { analyticsDb } from "../src/lib/db/analytics";
import { d2OkkDb } from "../src/lib/db/okk";

const BUH_GOS = 10935879;
const BERATER = 12154099;

type ARow = Record<string, unknown>;
function rows(res: unknown): ARow[] {
  if (Array.isArray(res)) return res as ARow[];
  if (res && typeof res === "object" && Array.isArray((res as { rows?: ARow[] }).rows))
    return (res as { rows: ARow[] }).rows;
  return [];
}

async function pipelineResponsibles(pipelineId: number): Promise<ARow[]> {
  return rows(
    await analyticsDb.execute(sql`
      SELECT
        responsible_user_id              AS "responsibleUserId",
        manager                          AS "manager",
        COUNT(*)::int                    AS "deals"
      FROM analytics.leads_cohort
      WHERE pipeline_id = ${pipelineId}
        AND is_deleted = FALSE
      GROUP BY responsible_user_id, manager
      ORDER BY deals DESC
    `)
  );
}

async function coverage(pipelineId: number): Promise<ARow[]> {
  return rows(
    await analyticsDb.execute(sql`
      SELECT
        COUNT(*)::int                                              AS deals_total,
        COUNT(responsible_user_id)::int                            AS with_responsible,
        COUNT(DISTINCT responsible_user_id)::int                   AS distinct_managers
      FROM analytics.leads_cohort
      WHERE pipeline_id = ${pipelineId} AND is_deleted = FALSE
    `)
  );
}

async function main(): Promise<void> {
  // Линии менеджеров из D2: kommo_user_id → line.
  const okkManagers = rows(
    await d2OkkDb.execute(sql`
      SELECT name, kommo_user_id, line, role FROM managers
    `)
  );
  const lineByKommoId = new Map<number, { name: string; line: string | null; role: string | null }>();
  for (const m of okkManagers) {
    const kid = m.kommo_user_id == null ? null : Number(m.kommo_user_id);
    if (kid !== null) lineByKommoId.set(kid, { name: String(m.name), line: m.line as string | null, role: m.role as string | null });
  }

  for (const [label, pid] of [["Бух Гос", BUH_GOS], ["Бух Бератер", BERATER]] as const) {
    const cov = coverage(pid);
    const resp = pipelineResponsibles(pid);
    const [c, r] = await Promise.all([cov, resp]);

    console.log(`\n========== ${label} (${pid}) ==========`);
    console.table(c);

    // Распределение сделок по линии ответственного.
    const byLine = new Map<string, number>();
    let matched = 0;
    let unmatched = 0;
    for (const row of r) {
      const kid = row.responsibleUserId == null ? null : Number(row.responsibleUserId);
      const deals = Number(row.deals);
      const m = kid !== null ? lineByKommoId.get(kid) : undefined;
      if (m) {
        const key = `линия ${m.line ?? "—"}${m.role === "rop" ? " (rop)" : ""}`;
        byLine.set(key, (byLine.get(key) ?? 0) + deals);
        matched += deals;
      } else {
        unmatched += deals;
      }
    }
    const lineDist = Array.from(byLine.entries())
      .map(([line, deals]) => ({ line, deals }))
      .sort((a, b) => b.deals - a.deals);
    console.log("Распределение сделок по линии ответственного:");
    console.table(lineDist);
    console.log(`  сматчено с менеджером ОКК: ${matched}, не сматчено (нет в D2 managers): ${unmatched}`);

    // Топ-8 ответственных с их линией.
    console.log("Топ ответственных:");
    console.table(
      r.slice(0, 8).map((row) => {
        const kid = row.responsibleUserId == null ? null : Number(row.responsibleUserId);
        const m = kid !== null ? lineByKommoId.get(kid) : undefined;
        return {
          manager: row.manager ?? `ID ${kid}`,
          deals: Number(row.deals),
          line_okk: m?.line ?? "—",
          role: m?.role ?? "—",
        };
      })
    );
  }

  console.log("\nГотово. Только чтение.");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("Ошибка:", e);
    process.exit(1);
  });
