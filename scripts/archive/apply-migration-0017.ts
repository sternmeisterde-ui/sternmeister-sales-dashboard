// One-off applier for 0017_contacts.sql.
// Creates analytics.contacts and analytics.lead_contact_links tables for
// the Funnel Dashboard. All statements use IF NOT EXISTS — safe to re-run.
//
//   npx tsx scripts/apply-migration-0017.ts
import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

import { sql } from "drizzle-orm";
import { analyticsDb } from "../src/lib/db/analytics";

async function tableExists(tableName: string): Promise<boolean> {
  const r = await analyticsDb.execute<{ exists: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'analytics'
        AND table_name = ${tableName}
    ) AS exists
  `);
  return Boolean(r.rows[0]?.exists);
}

async function countRows(tableName: string): Promise<number> {
  if (!(await tableExists(tableName))) return 0;
  const r = await analyticsDb.execute<{ n: string }>(sql`
    SELECT COUNT(*)::text AS n FROM analytics.${sql.raw(tableName)}
  `);
  return Number(r.rows[0]?.n ?? 0);
}

async function main(): Promise<void> {
  console.log("=== Applying 0017_contacts ===");

  const beforeContacts = await countRows("contacts");
  const beforeLinks = await countRows("lead_contact_links");
  console.log(
    `Before: contacts=${beforeContacts}, lead_contact_links=${beforeLinks}`,
  );

  // Step 1 — analytics.contacts
  console.log("Step 1: CREATE TABLE analytics.contacts ...");
  const t0 = Date.now();
  await analyticsDb.execute(sql`
    CREATE TABLE IF NOT EXISTS analytics.contacts (
      contact_id          BIGINT PRIMARY KEY,
      name                TEXT,
      first_name          TEXT,
      last_name           TEXT,
      phone               TEXT,
      phones_all          JSONB,
      responsible_user_id BIGINT,
      kommo_created_at    TIMESTAMP,
      kommo_updated_at    TIMESTAMP,
      raw_payload         JSONB NOT NULL,
      synced_at           TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  await analyticsDb.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_contacts_phone
      ON analytics.contacts (phone)
  `);
  await analyticsDb.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_contacts_updated_at
      ON analytics.contacts (kommo_updated_at)
  `);
  console.log(`  done ${Date.now() - t0}ms`);

  // Step 2 — analytics.lead_contact_links
  console.log("Step 2: CREATE TABLE analytics.lead_contact_links ...");
  const t1 = Date.now();
  await analyticsDb.execute(sql`
    CREATE TABLE IF NOT EXISTS analytics.lead_contact_links (
      lead_id        BIGINT NOT NULL,
      contact_id     BIGINT NOT NULL,
      first_seen_at  TIMESTAMP NOT NULL DEFAULT NOW(),
      last_seen_at   TIMESTAMP NOT NULL DEFAULT NOW(),
      is_active      BOOLEAN NOT NULL DEFAULT TRUE,
      PRIMARY KEY (lead_id, contact_id)
    )
  `);
  await analyticsDb.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_lcl_contact_id
      ON analytics.lead_contact_links (contact_id)
  `);
  await analyticsDb.execute(sql`
    CREATE INDEX IF NOT EXISTS idx_lcl_active
      ON analytics.lead_contact_links (lead_id)
      WHERE is_active = TRUE
  `);
  console.log(`  done ${Date.now() - t1}ms`);

  // Step 3 — Verify
  const contactsExists = await tableExists("contacts");
  const linksExists = await tableExists("lead_contact_links");
  console.log(
    contactsExists ? "Table analytics.contacts present ✅" : "Table contacts MISSING ❌",
  );
  console.log(
    linksExists
      ? "Table analytics.lead_contact_links present ✅"
      : "Table lead_contact_links MISSING ❌",
  );

  // Step 4 — List indexes for sanity
  const idx = await analyticsDb.execute<{ tablename: string; indexname: string }>(sql`
    SELECT tablename, indexname
    FROM pg_indexes
    WHERE schemaname = 'analytics'
      AND tablename IN ('contacts', 'lead_contact_links')
    ORDER BY tablename, indexname
  `);
  console.log("Indexes:");
  for (const r of idx.rows) {
    console.log(`  ${r.tablename}.${r.indexname}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("fatal:", e);
    process.exit(1);
  });
