// READ-ONLY: выборка топ/дно OKK-звонков B2B по линиям для проработки скриптов.
//   npx tsx scripts/diag-b2b-script-samples.ts [N=10]
//
// Только SELECT. Пишет по одному .txt на звонок в dev_docs/_b2b-analysis/<line>/
// (папка /dev_docs в .gitignore — PII в git НЕ попадает). В консоль — манифест без транскриптов.
//
// Сплит по линиям через evaluations.prompt_type:
//   r2_commercial → buh1 | r2_decisions → buh2 | r2_med_commercial → med1
//
// Транскрипты тянутся ПО ОДНОМУ за запрос с ретраями — Neon HTTP-драйвер
// таймаутит на больших ответах, поэтому дробим на мелкие устойчивые запросы.
import { config } from "dotenv";
import { resolve } from "node:path";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
config({ path: resolve(process.cwd(), ".env.local") });

import { neon } from "@neondatabase/serverless";

const N = Number(process.argv[2] ?? 10);
const OUT_DIR = resolve(process.cwd(), "dev_docs", "_b2b-analysis");

const LINE_BY_PROMPT: Record<string, string> = {
  r2_commercial: "buh1",
  r2_decisions: "buh2",
  r2_med_commercial: "med1",
};

interface Seg { speaker: string; text: string; start: number; end: number }

function renderTranscript(speakers: Seg[] | null, raw: string | null): string {
  if (Array.isArray(speakers) && speakers.length > 0) {
    return speakers.map((s) => `${s.speaker}: ${s.text}`).join("\n");
  }
  return raw ?? "";
}

async function withRetry<T>(label: string, fn: () => Promise<T>, tries = 4): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const wait = 800 * (i + 1);
      console.warn(`  ⚠ ${label}: попытка ${i + 1}/${tries} не удалась, повтор через ${wait}мс`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

async function main(): Promise<void> {
  const url = process.env.R2_OKK_DATABASE_URL;
  if (!url) throw new Error("R2_OKK_DATABASE_URL is not set in .env.local");
  const sql = neon(url);

  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });

  // 0) Распределение по prompt_type — проверка реальности данных.
  const dist = await withRetry("распределение", () => sql`
    SELECT e.prompt_type,
           COUNT(*)::int AS calls,
           ROUND(AVG(e.total_score)::numeric, 1)::float AS avg_score,
           MIN(e.total_score) AS min_score,
           MAX(e.total_score) AS max_score
    FROM evaluations e
    JOIN calls c ON c.id = e.call_id
    WHERE e.total_score IS NOT NULL AND c.manager_id IS NOT NULL
      AND c.transcript IS NOT NULL AND length(c.transcript) > 200
    GROUP BY e.prompt_type
    ORDER BY calls DESC`);
  console.log("=== Распределение по prompt_type (с транскриптом ≥200 симв., orphan-фильтр) ===");
  console.table(dist);

  // 1) Лёгкая выборка топ-N / дно-N (БЕЗ транскриптов — маленький ответ).
  const picks = await withRetry("выборка id", () => sql`
    WITH ranked AS (
      SELECT e.prompt_type, e.total_score, c.id AS call_id, c.manager_name,
             c.duration_seconds, c.call_created_at, e.mistakes,
             ROW_NUMBER() OVER (PARTITION BY e.prompt_type ORDER BY e.total_score DESC, c.duration_seconds DESC NULLS LAST) AS rn_top,
             ROW_NUMBER() OVER (PARTITION BY e.prompt_type ORDER BY e.total_score ASC,  c.duration_seconds DESC NULLS LAST) AS rn_bot
      FROM evaluations e
      JOIN calls c ON c.id = e.call_id
      WHERE e.total_score IS NOT NULL AND c.manager_id IS NOT NULL
        AND c.transcript IS NOT NULL AND length(c.transcript) > 200
        AND e.prompt_type IN ('r2_commercial', 'r2_decisions', 'r2_med_commercial')
    )
    SELECT prompt_type, total_score, call_id, manager_name, duration_seconds,
           call_created_at, mistakes, rn_top, rn_bot
    FROM ranked
    WHERE rn_top <= ${N} OR rn_bot <= ${N}
    ORDER BY prompt_type, total_score DESC`) as Record<string, unknown>[];

  console.log(`\nОтобрано ${picks.length} звонков. Тяну транскрипты по одному...`);

  const manifest: Array<Record<string, unknown>> = [];
  const counts: Record<string, { top: number; bottom: number }> = {};

  for (const p of picks) {
    const promptType = p.prompt_type as string;
    const line = LINE_BY_PROMPT[promptType] ?? promptType;
    const bucket = (p.rn_top as number) <= N ? "top" : "bottom";
    const score = p.total_score as number;
    const callId = p.call_id as string;
    const shortId = callId.slice(0, 8);
    const rank = bucket === "top" ? (p.rn_top as number) : (p.rn_bot as number);

    // Транскрипт — отдельным маленьким запросом с ретраями.
    const tr = await withRetry(`транскрипт ${shortId}`, () => sql`
      SELECT transcript, transcript_speakers FROM calls WHERE id = ${callId}`) as Record<string, unknown>[];
    const row = tr[0] ?? {};

    counts[line] ??= { top: 0, bottom: 0 };
    counts[line][bucket as "top" | "bottom"]++;

    const dir = resolve(OUT_DIR, line);
    mkdirSync(dir, { recursive: true });
    const fname = `${bucket}-${String(rank).padStart(2, "0")}_s${score}_${shortId}.txt`;

    const body = renderTranscript(
      row.transcript_speakers as Seg[] | null,
      row.transcript as string | null,
    );
    const header =
      `# Линия: ${line} (${promptType}) | bucket: ${bucket} | score: ${score}/100\n` +
      `# Менеджер: ${p.manager_name ?? "—"} | длительность: ${p.duration_seconds ?? "?"}с | дата: ${String(p.call_created_at ?? "—")}\n` +
      `# call_id: ${callId}\n` +
      `# ── Ошибки по оценке OKK ──\n${(p.mistakes as string) ?? "—"}\n` +
      `# ── ТРАНСКРИПТ ──\n`;
    writeFileSync(resolve(dir, fname), header + body, "utf8");

    manifest.push({
      line, bucket, score,
      dur_s: p.duration_seconds,
      len: (body as string)?.length ?? 0,
      manager: p.manager_name,
      file: `${line}/${fname}`,
    });
  }

  writeFileSync(resolve(OUT_DIR, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

  console.log(`\n=== Выборка записана в ${OUT_DIR} (N=${N} на bucket) ===`);
  console.table(
    Object.entries(counts).map(([line, c]) => ({ line, top: c.top, bottom: c.bottom, total: c.top + c.bottom })),
  );
  console.log("\n=== MANIFEST (без транскриптов) ===");
  console.table(manifest);
}

main().then(() => process.exit(0)).catch((e) => { console.error("fatal:", e); process.exit(1); });
