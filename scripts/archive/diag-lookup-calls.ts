// Read-only bulk lookup: for one or more kommo_lead_ids, find all OKK calls
// (D2 + R2) with score / prompt_type / errorMessage. Useful before drilling
// into individual calls with diag-call-eval.ts.
//
// Usage:
//   npx tsx scripts/diag-lookup-calls.ts --leads 19349147,19315109,19303223
//   npx tsx scripts/diag-lookup-calls.ts --leads 19349147
//
// Pure SELECT — no writes.

import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { desc, eq, inArray } from "drizzle-orm";
import { d2OkkDb, r2OkkDb, okkSchema } from "../src/lib/db/okk";

const args = process.argv.slice(2);
function arg(name: string): string | null {
  const idx = args.indexOf(`--${name}`);
  if (idx < 0) return null;
  return args[idx + 1] ?? null;
}

const leadsRaw = arg("leads");
if (!leadsRaw) {
  console.error("--leads <id1,id2,...> is required");
  process.exit(2);
}
const LEADS = leadsRaw.split(",").map((s) => s.trim()).filter(Boolean);

async function dump(label: string, db: typeof d2OkkDb) {
  const rows = await db
    .select({
      id: okkSchema.okkCalls.id,
      lead: okkSchema.okkCalls.kommoLeadId,
      mgr: okkSchema.okkCalls.managerName,
      created: okkSchema.okkCalls.callCreatedAt,
      dur: okkSchema.okkCalls.durationSeconds,
      status: okkSchema.okkCalls.status,
      err: okkSchema.okkCalls.errorMessage,
      curStatus: okkSchema.okkCalls.kommoStatusName,
      prompt: okkSchema.okkEvaluations.promptType,
      score: okkSchema.okkEvaluations.totalScore,
    })
    .from(okkSchema.okkCalls)
    .leftJoin(
      okkSchema.okkEvaluations,
      eq(okkSchema.okkEvaluations.callId, okkSchema.okkCalls.id),
    )
    .where(inArray(okkSchema.okkCalls.kommoLeadId, LEADS))
    .orderBy(desc(okkSchema.okkCalls.callCreatedAt));

  console.log(`\n=== ${label}  (${rows.length} rows) ===`);
  for (const r of rows) {
    console.log(
      `lead=${r.lead}  ${r.created?.toISOString()}  dur=${r.dur}s  mgr=${r.mgr}  prompt=${r.prompt ?? "—"}  score=${r.score ?? "—"}  curStatus=${r.curStatus ?? "—"}  status=${r.status}  err=${r.err ?? "—"}  call_id=${r.id}`,
    );
  }
}

async function main() {
  await dump("D2 OKK (B2G)", d2OkkDb);
  await dump("R2 OKK (B2B)", r2OkkDb);
}

main().then(() => process.exit(0));
