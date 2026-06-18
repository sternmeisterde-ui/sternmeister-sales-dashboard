// Read-only: dump bug_reports for the last N days.
// Source of manager-submitted comments (the "Сообщить об ошибке" popup).
// No DB-level link to call_id / kommo_lead_id — free-text only.
//
//   npx tsx scripts/diag-bug-reports.ts --days 7

import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { gte } from "drizzle-orm";
import { db as d1Db, schema as d1Schema } from "../src/lib/db";

const args = process.argv.slice(2);
function arg(n: string): string | null {
  const i = args.indexOf(`--${n}`);
  return i < 0 ? null : args[i + 1] ?? null;
}
const days = Number(arg("days") ?? "7");
const since = new Date(Date.now() - days * 24 * 3600 * 1000);

async function main() {
  const rows = await d1Db
    .select()
    .from(d1Schema.bugReports)
    .where(gte(d1Schema.bugReports.createdAt, since))
    .orderBy(d1Schema.bugReports.createdAt);

  console.log(`\nbug_reports — last ${days} days  (${rows.length} rows)\n`);
  if (rows.length === 0) {
    console.log("(пусто)");
    return;
  }
  for (const r of rows) {
    const created = r.createdAt ? new Date(r.createdAt).toISOString().slice(0, 16).replace("T", " ") : "—";
    console.log("─".repeat(80));
    console.log(
      `  ${created}Z   ${r.reporterName} (${r.reporterRole}, ${r.reporterDepartment})   раздел=${r.section}   дата=${r.reportDate}`,
    );
    console.log("");
    console.log(r.description);
    console.log("");
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
