// One-shot: wipe cached files for an analysis, reset its row to pending,
// then run the pipeline directly (bypasses /api/analysis/process which
// requires an admin session cookie).
//
//   npx tsx scripts/rerun-analysis.ts <analysis-id>

import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

import { eq } from "drizzle-orm";
import { getDbForDepartment } from "../src/lib/db";
import { callAnalyses, callAnalysisFiles } from "../src/lib/db/schema-existing";
import { runAnalysisPipeline } from "../src/lib/analysis/pipeline";

async function main(): Promise<void> {
  const id = process.argv[2];
  if (!id) {
    console.error("usage: npx tsx scripts/rerun-analysis.ts <analysis-id>");
    process.exit(1);
  }

  const db = getDbForDepartment("b2g");

  const [row] = await db.select().from(callAnalyses).where(eq(callAnalyses.id, id));
  if (!row) {
    console.error(`Analysis ${id} not found`);
    process.exit(1);
  }
  console.log(`Found analysis: status=${row.status} mode=${row.mode}`);
  console.log(`URL: ${row.kommoUrl}`);

  console.log("Deleting cached files...");
  const deleted = await db
    .delete(callAnalysisFiles)
    .where(eq(callAnalysisFiles.analysisId, id))
    .returning({ filename: callAnalysisFiles.filename });
  console.log(`Deleted ${deleted.length} files`);

  console.log("Resetting analysis row to pending...");
  await db
    .update(callAnalyses)
    .set({
      status: "pending",
      progress: 0,
      processedCalls: 0,
      totalCalls: 0,
      errorMessage: null,
      resultSummary: null,
      expiresAt: null,
    })
    .where(eq(callAnalyses.id, id));

  console.log("Running pipeline...");
  await runAnalysisPipeline(id);
  console.log("Done.");
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
