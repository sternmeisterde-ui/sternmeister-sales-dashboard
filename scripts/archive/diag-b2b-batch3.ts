// READ-ONLY: третий батч для доуточнения скриптов B2B — ранги 21–40 по total_score
// на каждый prompt_type (НЕ пересекается с прежними: top 1–10, bottom 1–10, valtop 11–20).
// Зона near-miss (середина-верх) — где видно, что отделяет 80–90 от 100.
//   npx tsx scripts/diag-b2b-batch3.ts
import { config } from "dotenv";
import { resolve } from "node:path";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
config({ path: resolve(process.cwd(), ".env.local") });
import { neon } from "@neondatabase/serverless";

const OUT_DIR = resolve(process.cwd(), "dev_docs", "_b2b-analysis", "batch3");
const LINE_BY_PROMPT: Record<string, string> = { r2_commercial: "buh1", r2_decisions: "buh2", r2_med_commercial: "med1" };
interface Seg { speaker: string; text: string; start: number; end: number }
function render(speakers: Seg[] | null, raw: string | null): string {
  if (Array.isArray(speakers) && speakers.length > 0) return speakers.map((s) => `${s.speaker}: ${s.text}`).join("\n");
  return raw ?? "";
}
async function withRetry<T>(label: string, fn: () => Promise<T>, tries = 4): Promise<T> {
  let e: unknown;
  for (let i = 0; i < tries; i++) { try { return await fn(); } catch (err) { e = err; const w = 800 * (i + 1); console.warn(`  ⚠ ${label}: ${i + 1}/${tries}`); await new Promise((r) => setTimeout(r, w)); } }
  throw e;
}
async function main(): Promise<void> {
  const url = process.env.R2_OKK_DATABASE_URL;
  if (!url) throw new Error("R2_OKK_DATABASE_URL is not set");
  const sql = neon(url);
  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  const picks = await withRetry("выборка", () => sql`
    WITH ranked AS (
      SELECT e.prompt_type, e.total_score, c.id AS call_id, c.manager_name, c.duration_seconds, c.call_created_at, e.mistakes,
             ROW_NUMBER() OVER (PARTITION BY e.prompt_type ORDER BY e.total_score DESC, c.duration_seconds DESC NULLS LAST) AS rn
      FROM evaluations e JOIN calls c ON c.id = e.call_id
      WHERE e.total_score IS NOT NULL AND c.manager_id IS NOT NULL
        AND c.transcript IS NOT NULL AND length(c.transcript) > 200
        AND e.prompt_type IN ('r2_commercial','r2_decisions','r2_med_commercial')
    )
    SELECT prompt_type, total_score, call_id, manager_name, duration_seconds, call_created_at, mistakes, rn
    FROM ranked WHERE rn BETWEEN 21 AND 40 ORDER BY prompt_type, rn`) as Record<string, unknown>[];
  console.log(`Батч-3 отобрано: ${picks.length}. Тяну транскрипты...`);
  const manifest: Array<Record<string, unknown>> = [];
  for (const p of picks) {
    const line = LINE_BY_PROMPT[p.prompt_type as string] ?? (p.prompt_type as string);
    const callId = p.call_id as string; const shortId = callId.slice(0, 8); const rn = p.rn as number;
    const tr = await withRetry(`тр ${shortId}`, () => sql`SELECT transcript, transcript_speakers FROM calls WHERE id = ${callId}`) as Record<string, unknown>[];
    const row = tr[0] ?? {};
    const dir = resolve(OUT_DIR, line); mkdirSync(dir, { recursive: true });
    const fname = `r${String(rn).padStart(2, "0")}_s${p.total_score}_${shortId}.txt`;
    const header = `# ${line} (${p.prompt_type}) | rank ${rn} | score ${p.total_score}/100 | ${p.manager_name ?? "—"} | ${p.duration_seconds ?? "?"}с\n# call_id: ${callId}\n# ── Ошибки OKK ──\n${(p.mistakes as string) ?? "—"}\n# ── ТРАНСКРИПТ ──\n`;
    writeFileSync(resolve(dir, fname), header + render(row.transcript_speakers as Seg[] | null, row.transcript as string | null), "utf8");
    manifest.push({ line, rn, score: p.total_score, manager: p.manager_name, file: `${line}/${fname}` });
  }
  writeFileSync(resolve(OUT_DIR, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  console.log(`\nЗаписано в ${OUT_DIR}`); console.table(manifest);
}
main().then(() => process.exit(0)).catch((e) => { console.error("fatal:", e); process.exit(1); });
