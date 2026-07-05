// Поштучный список cg-leg исходящих МОПов за день — для сверки с кабинетной
// выгрузкой CallGear. READ-ONLY.
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });
import dns from "node:dns";
dns.setDefaultResultOrder("ipv4first");
import { neon } from "@neondatabase/serverless";
import { NAME_ALIASES } from "../src/lib/daily/name-aliases";

async function main() {
  const ymd = process.argv[2] ?? "2026-06-27";
  const fromUtc = new Date(`${ymd}T00:00:00+02:00`);
  const toUtcExcl = new Date(fromUtc.getTime() + 86_400_000);

  const d1 = neon(process.env.DATABASE_URL!);
  const masters = (await d1`
    SELECT name FROM master_managers
    WHERE department = 'b2b' AND is_active = true
      AND role IN ('manager', 'teamlead', 'rop')`) as Array<{ name: string }>;
  const names: string[] = [];
  for (const m of masters) {
    names.push(m.name);
    for (const a of NAME_ALIASES[m.name] ?? []) names.push(a);
  }

  const adb = neon(process.env.ANALYTICS_DATABASE_URL!);
  const rows = (await adb`
    SELECT DISTINCT ON (communication_id)
      communication_id, manager, communication_type, duration, wait_seconds, phone,
      to_char(created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin', 'HH24:MI:SS') AS berlin_time
    FROM analytics.communications
    WHERE created_at >= ${fromUtc.toISOString()} AND created_at < ${toUtcExcl.toISOString()}
      AND manager = ANY(${names})
      AND communication_type LIKE 'call%'
      AND communication_id LIKE 'cg-leg:%'
    ORDER BY communication_id, lead_id NULLS LAST
  `) as Array<Record<string, unknown>>;

  rows.sort((a, b) => String(b.berlin_time).localeCompare(String(a.berlin_time)));
  console.log(`cg-leg звонки МОПов за ${ymd}: ${rows.length}`);
  for (const r of rows) {
    const full = Number(r.duration ?? 0) + Number(r.wait_seconds ?? 0);
    console.log(`  ${r.berlin_time}  ${String(r.manager).padEnd(24)} ${r.communication_type}  full=${full}с (talk=${r.duration}, wait=${r.wait_seconds})  тел=${r.phone}  ${r.communication_id}`);
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
