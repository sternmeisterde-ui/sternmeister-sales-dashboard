// SLA b2b за день: значение плитки (AVG sla_own_seconds) + разбивка по
// sla_own_status. READ-ONLY.
// Usage: npx tsx scripts/diag-sla-b2b-day.ts [YMD]
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });
import dns from "node:dns";
dns.setDefaultResultOrder("ipv4first");
import { neon } from "@neondatabase/serverless";

async function main() {
  const ymd = process.argv[2] ?? "2026-06-29";
  const fromUtc = new Date(`${ymd}T00:00:00+02:00`);
  const toUtcExcl = new Date(fromUtc.getTime() + 86_400_000);
  const adb = neon(process.env.ANALYTICS_DATABASE_URL!);
  const r = (await adb`
    SELECT
      round(AVG(sla_own_seconds)::numeric / 60) AS tile_min,
      COUNT(*) FILTER (WHERE sla_own_seconds IS NOT NULL) AS counted,
      COUNT(*) AS leads_total
    FROM analytics.sla
    WHERE lead_created_at >= ${fromUtc.toISOString()} AND lead_created_at < ${toUtcExcl.toISOString()}
      AND pipeline_id IN (10631243, 13209983)`) as Array<Record<string, unknown>>;
  const st = (await adb`
    SELECT sla_own_status, COUNT(*) AS n,
           round(AVG(sla_own_seconds)::numeric / 60) AS avg_min
    FROM analytics.sla
    WHERE lead_created_at >= ${fromUtc.toISOString()} AND lead_created_at < ${toUtcExcl.toISOString()}
      AND pipeline_id IN (10631243, 13209983)
    GROUP BY 1 ORDER BY n DESC`) as Array<Record<string, unknown>>;
  console.log(`=== ${ymd} === плитка SLA: ${r[0].tile_min} мин (учтено ${r[0].counted} из ${r[0].leads_total} лидов)`);
  for (const s of st) console.log(`  ${String(s.sla_own_status ?? "NULL").padEnd(18)} n=${s.n}  avg=${s.avg_min ?? "—"}м`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
