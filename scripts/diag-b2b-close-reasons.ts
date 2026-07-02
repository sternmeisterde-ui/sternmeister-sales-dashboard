// Точные строки причин закрытия b2b: distinct loss_reason в leads_cohort
// (b2b воронки) + справочник refusal_enums (cf 876383). READ-ONLY.
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });
import dns from "node:dns";
dns.setDefaultResultOrder("ipv4first");
import { neon } from "@neondatabase/serverless";

async function main() {
  const adb = neon(process.env.ANALYTICS_DATABASE_URL!);
  const lr = (await adb`
    SELECT loss_reason, COUNT(*) AS n
    FROM analytics.leads_cohort
    WHERE pipeline_id IN (10631243, 13209983) AND loss_reason IS NOT NULL
    GROUP BY loss_reason ORDER BY n DESC`) as Array<Record<string, unknown>>;
  console.log("distinct loss_reason (b2b):");
  for (const r of lr) console.log(`  ${r.n}  «${r.loss_reason}»`);

  const en = (await adb`
    SELECT * FROM analytics.refusal_enums ORDER BY 1 LIMIT 60`) as Array<Record<string, unknown>>;
  console.log("\nrefusal_enums:");
  for (const r of en) console.log(" ", JSON.stringify(r));

  // Как соотносятся b2b_close_reason_enum_id и loss_reason
  const cr = (await adb`
    SELECT b2b_close_reason_enum_id, loss_reason, COUNT(*) AS n
    FROM analytics.leads_cohort
    WHERE pipeline_id IN (10631243, 13209983) AND b2b_close_reason_enum_id IS NOT NULL
    GROUP BY 1, 2 ORDER BY n DESC LIMIT 25`) as Array<Record<string, unknown>>;
  console.log("\nenum_id ↔ loss_reason (b2b):");
  for (const r of cr) console.log(`  ${r.n}  enum=${r.b2b_close_reason_enum_id}  «${r.loss_reason}»`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
