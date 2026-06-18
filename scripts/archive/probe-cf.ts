// Inspect CF 879824 metadata + values on expected leads.
import { kommoFetchPath } from "../src/lib/kommo/client";

const EXPECTED = [18808190, 14579346, 18594580, 16329684, 12689418, 14496730, 13026014, 14489140, 11555672];

async function main() {
  const meta: any = await kommoFetchPath(`/leads/custom_fields/879824`);
  console.log("=== CF 879824 meta ===");
  console.log("name:", meta?.name, "| type:", meta?.type, "| code:", meta?.code);
  if (meta?.enums) {
    console.log("enums (first 10):");
    for (const e of meta.enums.slice(0, 10)) console.log(`  ${e.id} -> ${e.value} (sort=${e.sort})`);
    console.log(`total enums: ${meta.enums.length}`);
  }
  console.log("\n=== Lead CF 879824 values ===");
  for (const id of EXPECTED) {
    const lead: any = await kommoFetchPath(`/leads/${id}`);
    const f = (lead?.custom_fields_values || []).find((c: any) => c.field_id === 879824);
    const vals = f ? f.values.map((v: any) => `${v.value} (enum=${v.enum_id})`).join(", ") : "<not set>";
    console.log(`  ${id}: ${vals}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
