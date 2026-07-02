// Распределение исходящих по префиксам стран для ct: vs cg-leg: (b2b МОПы,
// последние 30 дней) — проверка гипотезы «CloudTalk = немецкие номера,
// CallGear = остальные». READ-ONLY.
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });
import dns from "node:dns";
dns.setDefaultResultOrder("ipv4first");
import { neon } from "@neondatabase/serverless";
import { NAME_ALIASES } from "../src/lib/daily/name-aliases";

async function main() {
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
    WITH deduped AS (
      SELECT DISTINCT ON (communication_id)
        communication_id,
        CASE WHEN communication_id LIKE 'cg-leg:%' THEN 'cg' ELSE 'ct' END AS src,
        regexp_replace(COALESCE(phone, ''), '\\D', '', 'g') AS p
      FROM analytics.communications
      WHERE created_at >= now() - interval '30 days'
        AND manager = ANY(${names})
        AND communication_type = 'call_out'
        AND (communication_id LIKE 'cg-leg:%' OR communication_id LIKE 'ct:%')
      ORDER BY communication_id, lead_id NULLS LAST
    )
    SELECT src,
      CASE
        WHEN p LIKE '49%' OR p LIKE '015%' OR p LIKE '016%' OR p LIKE '017%' THEN 'DE (49)'
        WHEN p LIKE '380%' THEN 'UA (380)'
        WHEN p LIKE '43%'  THEN 'AT (43)'
        WHEN p LIKE '42%'  THEN 'CZ/SK (42x)'
        WHEN p LIKE '30%'  THEN 'GR (30)'
        WHEN p LIKE '373%' THEN 'MD (373)'
        WHEN p LIKE '7%'   THEN 'RU/KZ (7)'
        ELSE 'другое'
      END AS country,
      COUNT(*) AS n
    FROM deduped
    GROUP BY 1, 2
    ORDER BY src, n DESC`) as Array<{ src: string; country: string; n: string }>;

  let cur = "";
  for (const r of rows) {
    if (r.src !== cur) { console.log(`\n${r.src === "ct" ? "CloudTalk" : "CallGear"}:`); cur = r.src; }
    console.log(`  ${r.country.padEnd(14)} ${r.n}`);
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
