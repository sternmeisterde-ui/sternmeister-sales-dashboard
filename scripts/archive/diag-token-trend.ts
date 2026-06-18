// Read-only: how tokens_used per evaluation changed over time on d2_qualifier.
// Answers "did the Grok model upgrade make us much more expensive?"
//
// Usage:
//   npx tsx scripts/diag-token-trend.ts

import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { sql } from "drizzle-orm";
import { d2OkkDb, okkSchema } from "../src/lib/db/okk";

async function main() {
  const rows = await d2OkkDb
    .select({
      promptType: okkSchema.okkEvaluations.promptType,
      tokensUsed: okkSchema.okkEvaluations.tokensUsed,
      modelUsed: okkSchema.okkEvaluations.modelUsed,
      createdAt: okkSchema.okkEvaluations.createdAt,
    })
    .from(okkSchema.okkEvaluations)
    .where(sql`${okkSchema.okkEvaluations.tokensUsed} IS NOT NULL AND ${okkSchema.okkEvaluations.tokensUsed} > 0`)
    .orderBy(okkSchema.okkEvaluations.createdAt);

  console.log(`Всего eval записей с tokens_used > 0: ${rows.length}\n`);

  // Group by week + prompt_type + model
  type Key = string;
  const buckets = new Map<Key, { tokens: number[]; models: Set<string> }>();
  for (const r of rows) {
    const week = new Date(r.createdAt!).toISOString().slice(0, 10);
    const monthBucket = new Date(r.createdAt!);
    monthBucket.setUTCDate(1);
    const m = monthBucket.toISOString().slice(0, 7);
    const key = `${m}|${r.promptType}`;
    let b = buckets.get(key);
    if (!b) { b = { tokens: [], models: new Set() }; buckets.set(key, b); }
    b.tokens.push(r.tokensUsed ?? 0);
    if (r.modelUsed) b.models.add(r.modelUsed);
  }

  console.log("Tokens per call: распределение по месяцам + prompt_type\n");
  console.log("month   | prompt           | N   | avg     | median  | p90     | model(s)");
  console.log("--------|------------------|-----|---------|---------|---------|------");

  const sortedKeys = [...buckets.keys()].sort();
  for (const k of sortedKeys) {
    const [m, pt] = k.split("|");
    const b = buckets.get(k)!;
    const sorted = [...b.tokens].sort((a, b) => a - b);
    const avg = Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length);
    const median = sorted[Math.floor(sorted.length / 2)];
    const p90 = sorted[Math.floor(sorted.length * 0.9)];
    const models = [...b.models].join(",");
    console.log(
      `${m} | ${pt.padEnd(17)} | ${String(sorted.length).padStart(3)} | ${String(avg).padStart(7)} | ${String(median).padStart(7)} | ${String(p90).padStart(7)} | ${models}`,
    );
  }

  // Overall by model
  console.log("\n\nИтого по model:");
  const byModel = new Map<string, number[]>();
  for (const r of rows) {
    if (!r.modelUsed || !r.tokensUsed) continue;
    let arr = byModel.get(r.modelUsed);
    if (!arr) { arr = []; byModel.set(r.modelUsed, arr); }
    arr.push(r.tokensUsed);
  }
  for (const [model, tokens] of byModel.entries()) {
    const sorted = [...tokens].sort((a, b) => a - b);
    const avg = Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length);
    const median = sorted[Math.floor(sorted.length / 2)];
    console.log(`  ${model.padEnd(25)} N=${sorted.length} avg=${avg} median=${median} min=${sorted[0]} max=${sorted[sorted.length - 1]}`);
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
