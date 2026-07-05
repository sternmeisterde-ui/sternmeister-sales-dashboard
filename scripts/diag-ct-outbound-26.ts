// Сверка с дашбордом CloudTalk (26.06, Агенты KOMM, Outbound):
// Total calls 241, Total talking time 5:46:41 (=20801с). READ-ONLY.

import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });
import dns from "node:dns";
dns.setDefaultResultOrder("ipv4first");
import { neon } from "@neondatabase/serverless";
import { NAME_ALIASES } from "../src/lib/daily/name-aliases";

const fmt = (s: number) => `${Math.floor(s / 3600)}ч ${Math.floor((s % 3600) / 60)}м ${s % 60}с`;

async function main() {
  const ymd = process.argv[2] ?? "2026-06-26";
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
  const r = (await adb`
    WITH deduped AS (
      SELECT DISTINCT ON (communication_id) communication_id, duration, wait_seconds
      FROM analytics.communications
      WHERE created_at >= ${fromUtc.toISOString()} AND created_at < ${toUtcExcl.toISOString()}
        AND manager = ANY(${names})
        AND communication_type = 'call_out'
        AND communication_id LIKE 'ct:%'
      ORDER BY communication_id, lead_id NULLS LAST
    )
    SELECT COUNT(*) AS n,
           COALESCE(SUM(duration), 0) AS talk_s,
           COALESCE(SUM(duration + COALESCE(wait_seconds, 0)), 0) AS full_s,
           COUNT(*) FILTER (WHERE duration >= 1) AS answered
    FROM deduped`) as Array<{ n: string; talk_s: string; full_s: string; answered: string }>;

  const { n, talk_s, full_s, answered } = r[0];
  console.log(`CloudTalk исходящие МОПов за ${ymd} в БД:`);
  console.log(`  n=${n} (дашборд CT: 241)`);
  console.log(`  SUM(duration)      = ${talk_s}с = ${fmt(Number(talk_s))}   (дашборд CT talking: 5ч 46м 41с = 20801с)`);
  console.log(`  SUM(duration+wait) = ${full_s}с = ${fmt(Number(full_s))}`);
  console.log(`  answered=${answered} → ср. разговор = ${Math.round(Number(talk_s) / Number(answered))}с (дашборд CT avg talking: 132с)`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
