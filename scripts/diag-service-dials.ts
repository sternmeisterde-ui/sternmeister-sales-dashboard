// Сколько в analytics служебных наборов (исходящие телефонии на номера
// короче 6 цифр, типа «88») — кандидаты на фильтр/чистку (спека 22 п.10).
// READ-ONLY.
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });
import dns from "node:dns";
dns.setDefaultResultOrder("ipv4first");
import { neon } from "@neondatabase/serverless";

async function main() {
  const adb = neon(process.env.ANALYTICS_DATABASE_URL!);
  const r = (await adb`
    SELECT
      CASE WHEN communication_id LIKE 'cg-leg:%' THEN 'cg' ELSE 'ct' END AS src,
      COUNT(*) AS rows_n,
      COUNT(DISTINCT communication_id) AS calls_n,
      MIN(created_at) AS mn, MAX(created_at) AS mx
    FROM analytics.communications
    WHERE communication_type = 'call_out'
      AND (communication_id LIKE 'cg-leg:%' OR communication_id LIKE 'ct:%')
      AND length(regexp_replace(COALESCE(phone, ''), '\\D', '', 'g')) < 6
    GROUP BY 1`) as Array<Record<string, unknown>>;
  console.log(JSON.stringify(r, null, 2));
  const top = (await adb`
    SELECT phone, COUNT(DISTINCT communication_id) AS n
    FROM analytics.communications
    WHERE communication_type = 'call_out'
      AND (communication_id LIKE 'cg-leg:%' OR communication_id LIKE 'ct:%')
      AND length(regexp_replace(COALESCE(phone, ''), '\\D', '', 'g')) < 6
    GROUP BY phone ORDER BY n DESC LIMIT 10`) as Array<Record<string, unknown>>;
  console.log("Топ 'номеров':", JSON.stringify(top));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
