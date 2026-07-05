// Однократно: Ирина Сафронова (b2b) — роль manager → prolongation.
// 1) master_managers (D1, источник правды)
// 2) R2 OKK managers (иначе до первого синка через /api/managers она
//    остаётся в белых списках вкладки ОКК — там роль читается из R2)
// Roleplay (r1_users) НЕ трогаем: CHECK допускает только manager/rop/admin,
// prolongation маппится в manager при синке (коммит 9a6863f) — она остаётся
// в ролевках, как и решено.
//
// Usage: npx tsx scripts/apply-safronova-prolongation.ts [--dry]

import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });
import dns from "node:dns";
dns.setDefaultResultOrder("ipv4first");
import { neon } from "@neondatabase/serverless";

const DRY = process.argv.includes("--dry");
const NAME = "Ирина Сафронова";

async function main() {
  const d1 = neon(process.env.DATABASE_URL!);
  const r2 = neon(process.env.R2_OKK_DATABASE_URL!);

  const before = await d1`
    SELECT id, name, role, department, is_active FROM master_managers
    WHERE name = ${NAME} AND department = 'b2b'`;
  console.log("D1 master_managers ДО:", JSON.stringify(before));
  if (before.length !== 1) throw new Error(`ожидали ровно 1 строку, получили ${before.length} — стоп`);

  const okkBefore = await r2`
    SELECT id, name, role, is_active FROM managers WHERE name = ${NAME}`;
  console.log("R2 managers ДО:", JSON.stringify(okkBefore));

  if (DRY) { console.log("\n--dry: изменений не вношу"); return; }

  const after = await d1`
    UPDATE master_managers SET role = 'prolongation', updated_at = now()
    WHERE id = ${before[0].id}
    RETURNING id, name, role`;
  console.log("\nD1 master_managers ПОСЛЕ:", JSON.stringify(after));

  if (okkBefore.length > 0) {
    const okkAfter = await r2`
      UPDATE managers SET role = 'prolongation', updated_at = now()
      WHERE name = ${NAME}
      RETURNING id, name, role`;
    console.log("R2 managers ПОСЛЕ:", JSON.stringify(okkAfter));
  }

  // Контроль: воспроизводим whitelist-запрос ростера (getManagersWithKommo)
  const roster = await d1`
    SELECT name FROM master_managers
    WHERE department = 'b2b' AND is_active = true
      AND role IN ('manager', 'teamlead', 'rop')
    ORDER BY name`;
  console.log("\nРостер b2b после смены (whitelist manager/teamlead/rop):");
  for (const r of roster) console.log("  " + r.name);
  const stillThere = roster.some((r) => r.name === NAME);
  console.log(stillThere ? "\n⚠ Сафронова ВСЁ ЕЩЁ в ростере!" : "\n✓ Сафронова исключена из продажных выборок");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
