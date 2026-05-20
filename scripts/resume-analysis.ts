// Resume a pipeline that errored partway. Does NOT delete cached files —
// runAnalysisPipeline skips files already in DB and continues from where
// the previous run left off.
//   npx tsx --env-file=.env.local scripts/resume-analysis.ts <analysis-id>
import { eq } from "drizzle-orm";
import { getDbForDepartment } from "../src/lib/db";
import { callAnalyses } from "../src/lib/db/schema-existing";
import { runAnalysisPipeline } from "../src/lib/analysis/pipeline";

async function main() {
  const id = process.argv[2];
  if (!id) { console.error("usage: resume-analysis.ts <id>"); process.exit(1); }
  const db = getDbForDepartment("b2g");
  const [row] = await db.select().from(callAnalyses).where(eq(callAnalyses.id, id));
  if (!row) { console.error(`Analysis ${id} not found`); process.exit(1); }
  console.log(`Found analysis: status=${row.status} processed=${row.processedCalls}/${row.totalCalls}`);
  // Pipeline guards on status. Flip to "pending" so it picks up the resume.
  await db.update(callAnalyses).set({ status: "pending", errorMessage: null }).where(eq(callAnalyses.id, id));
  console.log("Resuming pipeline...");
  await runAnalysisPipeline(id);
  console.log("Done.");
}
main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
