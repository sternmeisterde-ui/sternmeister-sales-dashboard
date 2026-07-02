// Проверка двух расхождений local-vs-kommo: свежесть связей в зеркале.
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
    SELECT l.lead_id, l.contact_id, l.is_active, l.last_seen_at,
           c.name AS contact_name, c.phone, c.synced_at,
           lc.pipeline, lc.status, lc.created_at AS lead_created
    FROM analytics.lead_contact_links l
    JOIN analytics.contacts c ON c.contact_id = l.contact_id
    LEFT JOIN analytics.leads_cohort lc ON lc.lead_id = l.lead_id
    WHERE l.lead_id IN (22072644, 22062498)
  `) as Array<Record<string, unknown>>;
  console.log(JSON.stringify(r, null, 2));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
