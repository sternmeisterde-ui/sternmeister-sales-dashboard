// Контроль после смены роли: плитка «Звонки» b2b за день по НОВОМУ ростеру
// (whitelist manager/teamlead/rop, как getManagersWithKommo). READ-ONLY.
// Usage: npx tsx scripts/diag-b2b-tile-after-role.ts [YMD]

import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });
import dns from "node:dns";
dns.setDefaultResultOrder("ipv4first");
import { neon } from "@neondatabase/serverless";
import { NAME_ALIASES } from "../src/lib/daily/name-aliases";

async function main() {
  const ymd = process.argv[2] ?? "2026-06-29";
  const fromUtc = new Date(`${ymd}T00:00:00+02:00`);
  const toUtcExcl = new Date(fromUtc.getTime() + 86_400_000);

  const d1 = neon(process.env.DATABASE_URL!);
  const roster = (await d1`
    SELECT name FROM master_managers
    WHERE department = 'b2b' AND is_active = true
      AND role IN ('manager', 'teamlead', 'rop')`) as Array<{ name: string }>;
  const names: string[] = [];
  for (const m of roster) {
    names.push(m.name);
    for (const a of NAME_ALIASES[m.name] ?? []) names.push(a);
  }

  const adb = neon(process.env.ANALYTICS_DATABASE_URL!);
  const agg = (await adb`
    WITH deduped AS (
      SELECT DISTINCT ON (communication_id) communication_id, communication_type, duration
      FROM analytics.communications
      WHERE created_at >= ${fromUtc.toISOString()} AND created_at < ${toUtcExcl.toISOString()}
        AND manager = ANY(${names})
      ORDER BY communication_id, lead_id NULLS LAST
    )
    SELECT
      COUNT(*) FILTER (WHERE communication_type = 'call_out') AS out_n,
      COUNT(*) FILTER (WHERE communication_type LIKE 'call%' AND duration >= 1) AS conn_n
    FROM deduped`) as Array<{ out_n: string; conn_n: string }>;
  const inLine = (await adb`
    SELECT COUNT(DISTINCT communication_id) AS n
    FROM analytics.communications
    WHERE created_at >= ${fromUtc.toISOString()} AND created_at < ${toUtcExcl.toISOString()}
      AND communication_type = 'call_in' AND line_name LIKE 'KOM%'`) as Array<{ n: string }>;

  const out = Number(agg[0].out_n), conn = Number(agg[0].conn_n), inn = Number(inLine[0].n);
  console.log(`${ymd}: исходящие(по агентам)=${out}, вх.KOM=${inn} → плитка «Звонки»=${out + inn}, дозвон=${conn}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
