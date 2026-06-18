// Inspect Kommo lead custom fields for pipelines 10631243 (Бух Комм) + 13209983 (Medical)
// to find the actual names of payment-date / payment-amount fields.
//
//   npx tsx scripts/inspect-custom-fields.ts

import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { getLeads } from "../src/lib/kommo/client";

async function main() {
  console.log("Inspecting custom fields on recent B2B WON/CLOSED leads...\n");
  const to = Math.floor(Date.now() / 1000);
  const from = to - 90 * 86400;

  for (const [label, pipelineId] of [
    ["Бух Комм", 10631243],
    ["Medical Admin Comm", 13209983],
  ] as const) {
    console.log(`\n=== ${label} (pipeline_id=${pipelineId}) ===`);
    const leads = await getLeads(
      [pipelineId],
      [142, 82946495, 82946499], // WON, Предоплата, Рассрочка
      2,
      { field: "closed_at", from, to },
    );
    console.log(`Found ${leads.length} recent closed/paid leads`);

    // Aggregate distinct field names + types across leads
    const fieldMap = new Map<string, { id: number; type: string; sampleValue: unknown }>();
    for (const lead of leads.slice(0, 20)) {
      for (const f of lead.custom_fields_values || []) {
        if (!f.field_name) continue;
        const key = f.field_name;
        if (!fieldMap.has(key)) {
          fieldMap.set(key, { id: f.field_id, type: f.field_type, sampleValue: f.values?.[0]?.value });
        }
      }
    }
    // Print fields containing payment / предоплат / сумма / дат
    const keywords = /плат|пред|сум|дат|аванс|оплат/i;
    for (const [name, info] of [...fieldMap.entries()].sort()) {
      const match = keywords.test(name);
      const mark = match ? "★" : " ";
      console.log(`  ${mark} [${info.id}] "${name}" (${info.type}) sample=${JSON.stringify(info.sampleValue)}`);
    }
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
