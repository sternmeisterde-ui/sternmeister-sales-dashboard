// Диагностика: текущая запись Сафроновой в master_managers. READ-ONLY.
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });
import dns from "node:dns";
dns.setDefaultResultOrder("ipv4first");
import { neon } from "@neondatabase/serverless";

async function main() {
  const d1 = neon(process.env.DATABASE_URL!);
  const rows = await d1`
    SELECT name, role, line, team, in_okk, in_rolevki, kommo_user_id,
           callgear_employee_id, cloudtalk_agent_id, is_active
    FROM master_managers WHERE name LIKE '%Сафронова%'`;
  console.log(JSON.stringify(rows, null, 2));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
