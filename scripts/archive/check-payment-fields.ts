// Checks whether Факт. Дата 1-го платежа / Сумма предоплаты ARE populated in Kommo
// across all WON/PAID leads in pipeline 10631243. If they are in Kommo but NOT
// in our analytics.leads_cohort — ETL bug.
// npx tsx scripts/check-payment-fields.ts

import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { getLeads } from "../src/lib/kommo/client";

const WATCHED: [string, string[]][] = [
  ["firstPaymentDate", ["Факт. Дата 1-го платежа", "Фактическая дата 1-го платежа", "Факт. дата 1-го платежа", "Дата 1-го платежа"]],
  ["firstPaymentAmount", ["Сумма 1-го платежа", "Сумма первого платежа"]],
  ["prepaymentDate", ["Дата предоплаты"]],
  ["prepaymentAmount", ["Сумма предоплаты"]],
];

function findByName(fields: Array<{ field_id: number; field_name: string; values: Array<{ value: unknown }> }> | null, names: string[]): unknown | undefined {
  if (!fields) return undefined;
  const norm = new Set(names.map((n) => n.toLowerCase().trim()));
  for (const f of fields) {
    if (f?.field_name && norm.has(f.field_name.toLowerCase().trim())) {
      return f.values?.[0]?.value;
    }
  }
  return undefined;
}

async function main() {
  const to = Math.floor(Date.now() / 1000);
  const from = to - 180 * 86400;
  const leads = await getLeads([10631243], [142, 82946495, 82946499], 5, { field: "closed_at", from, to });
  console.log(`Scanning ${leads.length} WON/paid leads from Бух Комм last 180d\n`);

  const stats = Object.fromEntries(WATCHED.map(([k]) => [k, 0]));
  for (const lead of leads) {
    for (const [key, names] of WATCHED) {
      const v = findByName(lead.custom_fields_values as unknown as Parameters<typeof findByName>[0], names);
      if (v !== undefined && v !== null && v !== "") stats[key] = (stats[key] ?? 0) + 1;
    }
  }

  console.log("Populated counts (out of", leads.length, "):");
  for (const [k, v] of Object.entries(stats)) console.log(`  ${k}: ${v}`);

  // Show first 3 leads' raw
  console.log("\nFirst 3 leads raw fields:");
  for (const lead of leads.slice(0, 3)) {
    console.log(`\n--- lead ${lead.id} (status ${lead.status_id}) ---`);
    for (const [key, names] of WATCHED) {
      const v = findByName(lead.custom_fields_values as unknown as Parameters<typeof findByName>[0], names);
      console.log(`  ${key} = ${JSON.stringify(v)}`);
    }
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
