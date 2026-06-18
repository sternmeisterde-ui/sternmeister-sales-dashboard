// Fetch ONE lead from Kommo and dump all custom fields
// npx tsx scripts/inspect-one-lead.ts [leadId=17592174]

import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { getLeads } from "../src/lib/kommo/client";

async function main() {
  const leadId = Number(process.argv[2] ?? 18946811);
  // Direct fetch by id
  const baseUrl = process.env.KOMMO_DOMAIN ? `https://${process.env.KOMMO_DOMAIN}/api/v4` : "";
  const token = process.env.KOMMO_ACCESS_TOKEN;
  if (!baseUrl || !token) { console.error("KOMMO_DOMAIN / KOMMO_ACCESS_TOKEN not set in env"); return; }
  const res = await fetch(`${baseUrl}/leads/${leadId}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) { console.error(`HTTP ${res.status}`); return; }
  const lead = await res.json() as { id: number; pipeline_id: number; status_id: number; price: number; custom_fields_values?: Array<{ field_id: number; field_name: string; field_type: string; values: Array<{ value: unknown }> }> };
  if (!lead) { console.log("Not found"); return; }
  console.log(`Lead ${lead.id} pipeline=${lead.pipeline_id} status=${lead.status_id} price=${lead.price}`);
  console.log("Custom fields:");
  for (const f of lead.custom_fields_values || []) {
    const v = f.values?.[0]?.value;
    console.log(`  [${f.field_id}] "${f.field_name}" (${f.field_type}) = ${JSON.stringify(v)}`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
