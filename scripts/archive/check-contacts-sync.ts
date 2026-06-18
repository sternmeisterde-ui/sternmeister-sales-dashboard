// Sanity checks after applying 0017_contacts + first sync-contacts run.
// Read-only — never modifies data. Safe to re-run.
//
//   npx tsx scripts/check-contacts-sync.ts
import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

import { sql } from "drizzle-orm";
import { analyticsDb } from "../src/lib/db/analytics";

async function main(): Promise<void> {
  console.log("=== Contacts sync sanity check ===\n");

  // 1. Counts
  const counts = await analyticsDb.execute<{
    contacts: string;
    contacts_with_phone: string;
    links_total: string;
    links_active: string;
  }>(sql`
    SELECT
      (SELECT COUNT(*)::text FROM analytics.contacts)                                   AS contacts,
      (SELECT COUNT(*)::text FROM analytics.contacts WHERE phone IS NOT NULL)           AS contacts_with_phone,
      (SELECT COUNT(*)::text FROM analytics.lead_contact_links)                         AS links_total,
      (SELECT COUNT(*)::text FROM analytics.lead_contact_links WHERE is_active = TRUE)  AS links_active
  `);
  const c = counts.rows[0]!;
  console.log("Counts:");
  console.log(`  contacts:            ${c.contacts}`);
  console.log(`  with phone:          ${c.contacts_with_phone}`);
  console.log(`  links (total):       ${c.links_total}`);
  console.log(`  links (active):      ${c.links_active}\n`);

  // 2. Phone count distribution
  console.log("Phone count distribution:");
  const phoneDist = await analyticsDb.execute<{ n_phones: number; cnt: string }>(sql`
    SELECT
      COALESCE(jsonb_array_length(phones_all), 0) AS n_phones,
      COUNT(*)::text AS cnt
    FROM analytics.contacts
    GROUP BY 1
    ORDER BY 1
  `);
  for (const r of phoneDist.rows) {
    console.log(`  ${r.n_phones} phones: ${r.cnt} contacts`);
  }
  console.log();

  // 3. Random 5 contacts (for eyeballing)
  console.log("Sample of 5 contacts:");
  const sample = await analyticsDb.execute<{
    contact_id: string;
    name: string | null;
    first_name: string | null;
    last_name: string | null;
    phone: string | null;
    phones_all: unknown;
  }>(sql`
    SELECT contact_id, name, first_name, last_name, phone, phones_all
    FROM analytics.contacts
    ORDER BY RANDOM()
    LIMIT 5
  `);
  for (const r of sample.rows) {
    const phones = JSON.stringify(r.phones_all);
    console.log(
      `  #${r.contact_id} | name=${JSON.stringify(r.name)} | first=${JSON.stringify(r.first_name)} | last=${JSON.stringify(r.last_name)} | phone=${JSON.stringify(r.phone)} | all=${phones}`,
    );
  }
  console.log();

  // 4. Top contacts by number of linked leads (re-used customers)
  console.log("Top 5 contacts by linked-lead count (likely repeat customers):");
  const top = await analyticsDb.execute<{
    contact_id: string;
    name: string | null;
    lead_count: string;
  }>(sql`
    SELECT c.contact_id, c.name, COUNT(lcl.lead_id)::text AS lead_count
    FROM analytics.contacts c
    JOIN analytics.lead_contact_links lcl ON lcl.contact_id = c.contact_id
    GROUP BY c.contact_id, c.name
    ORDER BY COUNT(lcl.lead_id) DESC, c.contact_id
    LIMIT 5
  `);
  for (const r of top.rows) {
    console.log(`  #${r.contact_id} | ${r.name} | ${r.lead_count} leads`);
  }
  console.log();

  // 5. Lead → contact ratio breakdown
  console.log("Lead-to-contact pairing breakdown:");
  const ratio = await analyticsDb.execute<{
    contacts_per_lead: number;
    n_leads: string;
  }>(sql`
    SELECT contacts_per_lead, COUNT(*)::text AS n_leads
    FROM (
      SELECT lead_id, COUNT(*) AS contacts_per_lead
      FROM analytics.lead_contact_links
      WHERE is_active = TRUE
      GROUP BY lead_id
    ) sub
    GROUP BY contacts_per_lead
    ORDER BY contacts_per_lead
  `);
  for (const r of ratio.rows) {
    console.log(`  ${r.contacts_per_lead} contact(s) per lead: ${r.n_leads} leads`);
  }
  console.log();

  // 6. Sanity: any contacts with empty raw_payload?
  const empty = await analyticsDb.execute<{ n: string }>(sql`
    SELECT COUNT(*)::text AS n
    FROM analytics.contacts
    WHERE raw_payload IS NULL OR raw_payload::text = '{}'
  `);
  console.log(
    `Contacts with empty raw_payload: ${empty.rows[0]?.n ?? "?"} (should be 0)`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("fatal:", e);
    process.exit(1);
  });
