// Проверка: к какому отделу реально относятся ответственные за Бух Гос сделки.
// Сверяем responsible_user_id (Гос) с master_managers (D1, источник правды:
// department b2g/b2b, role, line). ТОЛЬКО ЧТЕНИЕ.
//   npx tsx scripts/diag-gos-responsibles-dept.ts

import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { sql } from "drizzle-orm";
import { analyticsDb } from "../src/lib/db/analytics";
import { db } from "../src/lib/db/index";

type R = Record<string, unknown>;
function rows(res: unknown): R[] {
  if (Array.isArray(res)) return res as R[];
  if (res && typeof res === "object" && Array.isArray((res as { rows?: R[] }).rows))
    return (res as { rows: R[] }).rows;
  return [];
}

const BUH_GOS = 10935879;
const QUAL = [83873491, 90367079, 90367083, 90367087, 95514983, 104211575, 101935919, 95514987, 142, 143];

async function main(): Promise<void> {
  // Ответственные за Гос квал-сделки (с 2026-03-01) + кол-во.
  const respRows = rows(
    await analyticsDb.execute(sql`
      SELECT responsible_user_id AS "uid", manager AS "manager", COUNT(*)::int AS "leads"
      FROM analytics.leads_cohort
      WHERE pipeline_id = ${BUH_GOS}
        AND status_id IN (${sql.raw(QUAL.join(","))})
        AND is_deleted = FALSE
        AND created_at >= '2026-03-01'
        AND responsible_user_id IS NOT NULL
      GROUP BY responsible_user_id, manager
      ORDER BY leads DESC
    `)
  );

  // master_managers (D1) — kommo_user_id → отдел/роль/линия.
  const mmRows = rows(
    await db.execute(sql`
      SELECT kommo_user_id AS "uid", name, department, role, line, is_active AS "active"
      FROM master_managers
      WHERE kommo_user_id IS NOT NULL
    `)
  );
  const mm = new Map<number, R>();
  for (const m of mmRows) if (m.uid != null) mm.set(Number(m.uid), m);

  console.log("Ответственные за Бух Гос (с 2026-03-01) ↔ master_managers:\n");
  console.table(
    respRows.map((r) => {
      const uid = Number(r.uid);
      const m = mm.get(uid);
      return {
        "имя (Kommo)": r.manager ?? `ID ${uid}`,
        лиды: Number(r.leads),
        kommo_id: uid,
        "MM отдел": m ? String(m.department) : "❌ НЕТ в master",
        "MM роль": m ? String(m.role) : "—",
        "MM линия": m ? (m.line ?? "—") : "—",
        active: m ? String(m.active) : "—",
      };
    })
  );

  console.log("\nГотово. Только чтение.");
}

main().then(() => process.exit(0)).catch((e) => { console.error("Ошибка:", e); process.exit(1); });
