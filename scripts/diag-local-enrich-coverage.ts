// Сколько unenriched-телефонов из бэклога резолвится ЛОКАЛЬНО (без Kommo):
// (а) через analytics.contacts.phones_all → lead_contact_links;
// (б) через нашу же историю: другой звонок на тот же номер уже обогащён.
// Матч по последним 10 цифрам. READ-ONLY.
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });
import dns from "node:dns";
dns.setDefaultResultOrder("ipv4first");
import { neon } from "@neondatabase/serverless";

async function main() {
  const adb = neon(process.env.ANALYTICS_DATABASE_URL!);
  const r = (await adb`
    WITH backlog AS (
      SELECT DISTINCT right(regexp_replace(phone, '\\D', '', 'g'), 10) AS pnorm
      FROM analytics.communications
      WHERE lead_id IS NULL AND phone IS NOT NULL AND phone <> ''
        AND communication_type LIKE 'call%'
        AND created_at >= '2026-05-30'
        AND NOT EXISTS (SELECT 1 FROM analytics.enrich_skip_phones s
                        WHERE right(regexp_replace(s.phone, '\\D', '', 'g'), 10)
                            = right(regexp_replace(communications.phone, '\\D', '', 'g'), 10))
    ),
    via_contacts AS (
      SELECT DISTINCT b.pnorm
      FROM backlog b
      JOIN analytics.contacts c
        ON EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(COALESCE(c.phones_all, '[]'::jsonb)) p(v)
          WHERE right(regexp_replace(p.v, '\\D', '', 'g'), 10) = b.pnorm
        )
      JOIN analytics.lead_contact_links l ON l.contact_id = c.contact_id AND l.is_active
    ),
    via_history AS (
      SELECT DISTINCT b.pnorm
      FROM backlog b
      JOIN analytics.communications e
        ON e.lead_id IS NOT NULL AND e.phone IS NOT NULL
       AND right(regexp_replace(e.phone, '\\D', '', 'g'), 10) = b.pnorm
    )
    SELECT
      (SELECT COUNT(*) FROM backlog) AS backlog_phones,
      (SELECT COUNT(*) FROM via_contacts) AS via_contacts,
      (SELECT COUNT(*) FROM via_history) AS via_history,
      (SELECT COUNT(*) FROM backlog b
        WHERE b.pnorm IN (SELECT pnorm FROM via_contacts)
           OR b.pnorm IN (SELECT pnorm FROM via_history)) AS via_any
  `) as Array<Record<string, unknown>>;
  console.log(JSON.stringify(r[0], null, 2));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
