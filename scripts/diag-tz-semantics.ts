// Проба семантики AT TIME ZONE на живой базе + тип created_at. READ-ONLY.
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });
import dns from "node:dns";
dns.setDefaultResultOrder("ipv4first");
import { neon } from "@neondatabase/serverless";

async function main() {
  const adb = neon(process.env.ANALYTICS_DATABASE_URL!);
  const t = (await adb`
    SELECT pg_typeof(created_at) AS coltype, current_setting('TimeZone') AS session_tz
    FROM analytics.communications LIMIT 1`) as Array<Record<string, unknown>>;
  console.log("column type:", t[0].coltype, "| session tz:", t[0].session_tz);

  const probe = (await adb`
    SELECT
      '2026-07-01 18:57:08+00'::timestamptz                                              AS stored,
      ('2026-07-01 18:57:08+00'::timestamptz AT TIME ZONE 'UTC')                         AS step1_naive,
      (('2026-07-01 18:57:08+00'::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Berlin') AS step2,
      ('2026-07-01 18:57:08'::timestamp AT TIME ZONE 'Europe/Berlin')                    AS naive_as_berlin
  `) as Array<Record<string, unknown>>;
  for (const [k, v] of Object.entries(probe[0])) {
    console.log(`${k}: ${v instanceof Date ? v.toISOString() : v}`);
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
