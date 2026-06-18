// READ-ONLY: held-out выборка для валидации черновиков скриптов B2B.
//   npx tsx scripts/diag-b2b-validation-set.ts
//
// Берёт «второй эшелон» топов — места 11–20 по total_score на каждый prompt_type
// (НЕ пересекается с обучающей выборкой top-1..10). Пишет .txt по звонку в
// dev_docs/_b2b-analysis/validation/<line>/ (папка /dev_docs в .gitignore — PII не в git).
import { config } from "dotenv";
import { resolve } from "node:path";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
config({ path: resolve(process.cwd(), ".env.local") });

import { neon } from "@neondatabase/serverless";

const OUT_DIR = resolve(process.cwd(), "dev_docs", "_b2b-analysis", "validation");
const LINE_BY_PROMPT: Record<string, string> = {
  r2_commercial: "buh1", r2_decisions: "buh2", r2_med_commercial: "med1",
};
interface Seg { speaker: string; text: string; start: number; end: number }
function renderTranscript(speakers: Seg[] | null, raw: string | null): string {
  if (Array.isArray(speakers) && speakers.length > 0) return speakers.map((s) => `${s.speaker}: ${s.text}`).join("\n");
  return raw ?? "";
}
async function withRetry<T>(label: string, fn: () => Promise<T>, tries = 4): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e) { lastErr = e; const w = 800 * (i + 1); console.warn(`  ⚠ ${label}: ${i + 1}/${tries}, повтор ${w}мс`); await new Promise((r) => setTimeout(r, w)); }
  }
  throw lastErr;
}

async function main(): Promise<void> {
  const url = process.env.R2_OKK_DATABASE_URL;
  if (!url) throw new Error("R2_OKK_DATABASE_URL is not set");
  const sql = neon(url);
  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });

  const picks = await withRetry("выборка id", () => sql`
    WITH ranked AS (
      SELECT e.prompt_type, e.total_score, c.id AS call_id, c.manager_name,
             c.duration_seconds, c.call_created_at, e.mistakes,
             ROW_NUMBER() OVER (PARTITION BY e.prompt_type ORDER BY e.total_score DESC, c.duration_seconds DESC NULLS LAST) AS rn_top
      FROM evaluations e JOIN calls c ON c.id = e.call_id
      WHERE e.total_score IS NOT NULL AND c.manager_id IS NOT NULL
        AND c.transcript IS NOT NULL AND length(c.transcript) > 200
        AND e.prompt_type IN ('r2_commercial', 'r2_decisions', 'r2_med_commercial')
    )
    SELECT prompt_type, total_score, call_id, manager_name, duration_seconds, call_created_at, mistakes, rn_top
    FROM ranked WHERE rn_top BETWEEN 11 AND 20
    ORDER BY prompt_type, rn_top`) as Record<string, unknown>[];

  console.log(`Held-out отобрано: ${picks.length}. Тяну транскрипты...`);
  const manifest: Array<Record<string, unknown>> = [];
  for (const p of picks) {
    const line = LINE_BY_PROMPT[p.prompt_type as string] ?? (p.prompt_type as string);
    const callId = p.call_id as string;
    const shortId = callId.slice(0, 8);
    const rank = p.rn_top as number;
    const tr = await withRetry(`транскрипт ${shortId}`, () => sql`
      SELECT transcript, transcript_speakers FROM calls WHERE id = ${callId}`) as Record<string, unknown>[];
    const row = tr[0] ?? {};
    const dir = resolve(OUT_DIR, line);
    mkdirSync(dir, { recursive: true });
    const fname = `valtop-${String(rank).padStart(2, "0")}_s${p.total_score}_${shortId}.txt`;
    const header =
      `# Линия: ${line} (${p.prompt_type}) | held-out valtop | rank ${rank} | score: ${p.total_score}/100\n` +
      `# Менеджер: ${p.manager_name ?? "—"} | длит: ${p.duration_seconds ?? "?"}с | дата: ${String(p.call_created_at ?? "—")}\n` +
      `# call_id: ${callId}\n# ── Ошибки OKK ──\n${(p.mistakes as string) ?? "—"}\n# ── ТРАНСКРИПТ ──\n`;
    writeFileSync(resolve(dir, fname), header + renderTranscript(row.transcript_speakers as Seg[] | null, row.transcript as string | null), "utf8");
    manifest.push({ line, rank, score: p.total_score, manager: p.manager_name, file: `${line}/${fname}` });
  }
  writeFileSync(resolve(OUT_DIR, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  console.log(`\nЗаписано в ${OUT_DIR}`);
  console.table(manifest);
}
main().then(() => process.exit(0)).catch((e) => { console.error("fatal:", e); process.exit(1); });
