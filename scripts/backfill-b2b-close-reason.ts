/**
 * Backfill analytics.leads_cohort.b2b_close_reason_enum_id from Kommo
 * custom field 876383 ("Причины закрытия (Обязательное поле)").
 *
 * Why: 0007 added the column, sync-leads now populates it on every fresh
 * sync, but historical rows already in the table have it NULL. Re-sync
 * pulls the custom field for every B2B lead in the requested window and
 * UPDATEs in place. Faster than a full sync because we don't touch
 * unrelated columns.
 *
 * Usage:
 *   npx tsx scripts/backfill-b2b-close-reason.ts --from 2026-01-01 --to 2026-04-29
 *
 * Picks up B2B closed-lost leads only (status_id=143 on pipelines 10631243
 * Бух Комм / 13209983 Мед Комм) — the field is required at that status.
 */

import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

import { getLeads } from "@/lib/kommo/client";
import { analyticsDb } from "@/lib/db/analytics";
import { sql } from "drizzle-orm";

const FIELD_ID = 876383;
const PIPELINES = [10631243, 13209983]; // Бух Комм, Мед Комм
const CLOSED_LOST_STATUS_ID = 143;

interface CFValue { enum_id?: number }
interface CF { field_id: number; values: CFValue[] }

function extractEnumId(fields: CF[] | null | undefined): number | null {
  if (!fields) return null;
  const f = fields.find((x) => x.field_id === FIELD_ID);
  const v = f?.values?.[0]?.enum_id;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function parseArg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

async function main() {
  const from = parseArg("from");
  const to = parseArg("to");
  if (!from || !to) {
    console.error("Usage: --from YYYY-MM-DD --to YYYY-MM-DD");
    process.exit(1);
  }

  const fromTs = Math.floor(new Date(`${from}T00:00:00Z`).getTime() / 1000);
  const toTs = Math.floor(new Date(`${to}T23:59:59Z`).getTime() / 1000);

  console.log(`[backfill-close-reason] window: ${from} → ${to}`);
  console.log(`[backfill-close-reason] pulling closed-lost B2B leads from Kommo…`);

  const leads = await getLeads(
    PIPELINES,
    [CLOSED_LOST_STATUS_ID],
    500,
    { field: "closed_at", from: fromTs, to: toTs },
    false,
  );

  console.log(`[backfill-close-reason] ${leads.length} leads from Kommo`);

  let updated = 0;
  let withEnum = 0;
  let withoutEnum = 0;
  const CHUNK = 500;

  for (let i = 0; i < leads.length; i += CHUNK) {
    const chunk = leads.slice(i, i + CHUNK);
    for (const lead of chunk) {
      const enumId = extractEnumId(lead.custom_fields_values as CF[] | null);
      if (enumId !== null) withEnum++;
      else withoutEnum++;

      await analyticsDb.execute(sql`
        UPDATE analytics.leads_cohort
        SET b2b_close_reason_enum_id = ${enumId}
        WHERE lead_id = ${lead.id}
      `);
      updated++;
    }
    console.log(`[backfill-close-reason] processed ${Math.min(i + CHUNK, leads.length)}/${leads.length}`);
  }

  console.log(`[backfill-close-reason] done — updated=${updated}, with_enum=${withEnum}, without_enum=${withoutEnum}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
