// Распределение wait_seconds по CloudTalk-исходящим МОПов за день — подбор
// определения виджета CT «Avg. waiting time» (якоря: 26.06 avg=4с max=14с;
// 24.06 avg=8с max=18с). READ-ONLY.
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });
import dns from "node:dns";
dns.setDefaultResultOrder("ipv4first");
import { neon } from "@neondatabase/serverless";
import { NAME_ALIASES } from "../src/lib/daily/name-aliases";

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
      SELECT DISTINCT ON (communication_id)
        communication_id, duration, wait_seconds
      FROM analytics.communications
      WHERE created_at >= ${fromUtc.toISOString()} AND created_at < ${toUtcExcl.toISOString()}
        AND manager = ANY(${names})
        AND communication_type = 'call_out'
        AND communication_id LIKE 'ct:%'
      ORDER BY communication_id, lead_id NULLS LAST
    )
    SELECT
      COUNT(*) AS n,
      MAX(wait_seconds) AS max_wait,
      round(AVG(wait_seconds)) AS avg_all,
      round(AVG(wait_seconds) FILTER (WHERE duration >= 1)) AS avg_answered,
      round(AVG(wait_seconds) FILTER (WHERE duration < 1 OR duration IS NULL)) AS avg_unanswered,
      round(AVG(wait_seconds) FILTER (WHERE wait_seconds > 0)) AS avg_nonzero,
      COUNT(*) FILTER (WHERE wait_seconds = 0) AS n_zero,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY wait_seconds) AS median
    FROM deduped`) as Array<Record<string, unknown>>;
  console.log(`=== ${ymd}, ct: исходящие МОПов ===`);
  console.log(JSON.stringify(r[0], null, 2));

  // Гистограмма
  const h = (await adb`
    WITH deduped AS (
      SELECT DISTINCT ON (communication_id) communication_id, wait_seconds
      FROM analytics.communications
      WHERE created_at >= ${fromUtc.toISOString()} AND created_at < ${toUtcExcl.toISOString()}
        AND manager = ANY(${names})
        AND communication_type = 'call_out'
        AND communication_id LIKE 'ct:%'
      ORDER BY communication_id, lead_id NULLS LAST
    )
    SELECT width_bucket(wait_seconds, 0, 60, 6) AS b, COUNT(*) AS n
    FROM deduped GROUP BY 1 ORDER BY 1`) as Array<{ b: string; n: string }>;
  console.log("Гистограмма wait (0-10/10-20/.../50-60/60+):", h.map((x) => `${x.b}:${x.n}`).join("  "));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
