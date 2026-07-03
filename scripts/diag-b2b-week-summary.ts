// Сводка за 7 дней: исходящие b2b по источникам (CloudTalk/CallGear),
// отдельно Сафронова (роль prolongation), вх. по линии KOM. READ-ONLY.
// Usage: npx tsx scripts/diag-b2b-week-summary.ts [fromYMD] [toYMD]

import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });
import dns from "node:dns";
dns.setDefaultResultOrder("ipv4first");
import { neon } from "@neondatabase/serverless";
import { NAME_ALIASES } from "../src/lib/daily/name-aliases";

const BERLIN = "Europe/Berlin";
const berlinDay = (d: Date) => d.toLocaleDateString("sv", { timeZone: BERLIN });
function berlinMidnightUtc(ymd: string): Date {
  for (const off of ["+02:00", "+01:00"]) {
    const d = new Date(`${ymd}T00:00:00${off}`);
    if (new Intl.DateTimeFormat("sv", { timeZone: BERLIN, hour: "2-digit", hourCycle: "h23" }).format(d) === "00") return d;
  }
  throw new Error(`bad ymd ${ymd}`);
}

async function main() {
  const [fromArg, toArg] = process.argv.slice(2);
  const toYmd = toArg ?? berlinDay(new Date(Date.now() - 86_400_000));
  const fromYmd = fromArg ?? berlinDay(new Date(berlinMidnightUtc(toYmd).getTime() - 6 * 86_400_000));
  const fromUtc = berlinMidnightUtc(fromYmd);
  const toUtcExcl = new Date(berlinMidnightUtc(toYmd).getTime() + 86_400_000);

  const d1 = neon(process.env.DATABASE_URL!);
  const all = (await d1`
    SELECT name, role FROM master_managers
    WHERE department = 'b2b' AND is_active = true`) as Array<{ name: string; role: string }>;
  const salesNames: string[] = [];
  const prolongNames: string[] = [];
  for (const m of all) {
    const bucket = ["manager", "teamlead", "rop"].includes(m.role) ? salesNames : prolongNames;
    bucket.push(m.name);
    for (const a of NAME_ALIASES[m.name] ?? []) bucket.push(a);
  }

  const adb = neon(process.env.ANALYTICS_DATABASE_URL!);
  const rows = (await adb`
    WITH deduped AS (
      SELECT DISTINCT ON (communication_id)
        communication_id, communication_type, manager, duration, created_at
      FROM analytics.communications
      WHERE created_at >= ${fromUtc.toISOString()} AND created_at < ${toUtcExcl.toISOString()}
        AND manager = ANY(${[...salesNames, ...prolongNames]})
        AND communication_type = 'call_out'
      ORDER BY communication_id, lead_id NULLS LAST
    )
    SELECT
      to_char((created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin')::date, 'YYYY-MM-DD') AS day,
      COUNT(*) FILTER (WHERE communication_id LIKE 'ct:%'     AND manager = ANY(${salesNames}))   AS ct_sales,
      COUNT(*) FILTER (WHERE communication_id LIKE 'cg-leg:%' AND manager = ANY(${salesNames}))   AS cg_sales,
      COUNT(*) FILTER (WHERE manager = ANY(${prolongNames}))                                       AS prolong_out,
      COUNT(*) FILTER (WHERE duration >= 1 AND manager = ANY(${salesNames}))                       AS conn_sales
    FROM deduped GROUP BY day ORDER BY day
  `) as Array<Record<string, string>>;

  const inKom = (await adb`
    SELECT
      to_char((created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin')::date, 'YYYY-MM-DD') AS day,
      COUNT(DISTINCT communication_id) AS n
    FROM analytics.communications
    WHERE created_at >= ${fromUtc.toISOString()} AND created_at < ${toUtcExcl.toISOString()}
      AND communication_type = 'call_in' AND line_name LIKE 'KOM%'
    GROUP BY day ORDER BY day
  `) as Array<{ day: string; n: string }>;
  const inMap = new Map(inKom.map((r) => [r.day, Number(r.n)]));

  console.log(`Окно ${fromYmd}..${toYmd} (дни по Берлину). МОПы: ${salesNames.length ? "" : "—"}${[...new Set(salesNames)].length} имён; продления: ${prolongNames.join(", ") || "—"}\n`);
  console.log("День        | CloudTalk исх | CallGear исх | вх.KOM | ПЛИТКА «Звонки» | дозвон | Продления (вне подсчёта)");
  let tCt = 0, tCg = 0, tIn = 0, tConn = 0, tPr = 0;
  for (const r of rows) {
    const ct = Number(r.ct_sales), cg = Number(r.cg_sales), pr = Number(r.prolong_out), conn = Number(r.conn_sales);
    const inn = inMap.get(r.day) ?? 0;
    tCt += ct; tCg += cg; tIn += inn; tConn += conn; tPr += pr;
    console.log(`${r.day}  | ${String(ct).padStart(13)} | ${String(cg).padStart(12)} | ${String(inn).padStart(6)} | ${String(ct + cg + inn).padStart(15)} | ${String(conn).padStart(6)} | ${String(pr).padStart(8)}`);
  }
  console.log("-".repeat(110));
  console.log(`ИТОГО       | ${String(tCt).padStart(13)} | ${String(tCg).padStart(12)} | ${String(tIn).padStart(6)} | ${String(tCt + tCg + tIn).padStart(15)} | ${String(tConn).padStart(6)} | ${String(tPr).padStart(8)}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
