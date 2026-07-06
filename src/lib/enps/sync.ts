/**
 * Синк eNPS: Google Sheets → D1 enps_responses.
 *
 * Данных мало (десяток ответов в неделю), поэтому каждый тик читает лист
 * целиком и апсертит все строки по token — идемпотентно (правила
 * docs/etl-architecture.md), lease-lock не нужен: повторный/параллельный
 * прогон приводит к тем же строкам.
 */

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { enpsResponses } from "@/lib/db/schema-existing";
import { enpsSheetsConfigured, fetchEnpsSheetRows } from "./sheets";

export interface EnpsRow {
  token: string;
  score: number;
  supports: string | null;
  frustrates: string | null;
  submittedAt: Date;
}

export interface EnpsSyncResult {
  ok: boolean;
  fetched: number;
  upserted: number;
  skipped: number;
  error?: string;
}

/**
 * Колонки листа (Typeform → Sheets integration):
 * A score, B supports, C frustrates, D «Submitted At», E token.
 * Submitted At приходит без зоны — Typeform пишет UTC.
 */
function parseSheetRow(row: string[]): EnpsRow | null {
  const [rawScore, supports, frustrates, rawSubmitted, token] = row;
  if (!token?.trim()) return null;

  const score = Number.parseFloat(rawScore ?? "");
  if (!Number.isFinite(score) || score < 0 || score > 10) return null;

  const submittedAt = new Date(`${(rawSubmitted ?? "").trim().replace(" ", "T")}Z`);
  if (Number.isNaN(submittedAt.getTime())) return null;

  return {
    token: token.trim(),
    score: Math.round(score),
    supports: supports?.trim() || null,
    frustrates: frustrates?.trim() || null,
    submittedAt,
  };
}

/** Общий upsert — используется и синком, и сид-скриптом из xlsx-копии. */
export async function upsertEnpsRows(rows: EnpsRow[], department = "b2g"): Promise<number> {
  if (rows.length === 0) return 0;
  await db
    .insert(enpsResponses)
    .values(rows.map((r) => ({ ...r, department })))
    .onConflictDoUpdate({
      target: enpsResponses.token,
      set: {
        score: sql`excluded.score`,
        supports: sql`excluded.supports`,
        frustrates: sql`excluded.frustrates`,
        submittedAt: sql`excluded.submitted_at`,
        syncedAt: sql`now()`,
      },
    });
  return rows.length;
}

export async function syncEnps(): Promise<EnpsSyncResult> {
  if (!enpsSheetsConfigured()) {
    return { ok: false, fetched: 0, upserted: 0, skipped: 0, error: "not configured" };
  }
  try {
    const raw = await fetchEnpsSheetRows();
    const rows = raw.map(parseSheetRow).filter((r): r is EnpsRow => r !== null);
    const upserted = await upsertEnpsRows(rows);
    return { ok: true, fetched: raw.length, upserted, skipped: raw.length - rows.length };
  } catch (e) {
    return {
      ok: false,
      fetched: 0,
      upserted: 0,
      skipped: 0,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

// ── Stale-while-revalidate ──────────────────────────────────────────
// GET /api/enps отдаёт данные из D1 сразу, а освежение из Sheets дёргает
// фоном не чаще раза в 30 минут (паттерн Активность/Дейли — не блокировать
// чтение внешним API). Маркер процессный: после рестарта первый GET
// просто синканёт лишний раз — безвредно.
const REFRESH_INTERVAL_MS = 30 * 60_000;
let lastAttemptAt = 0;

export function maybeSyncEnpsInBackground(): void {
  if (!enpsSheetsConfigured()) return;
  const now = Date.now();
  if (now - lastAttemptAt < REFRESH_INTERVAL_MS) return;
  lastAttemptAt = now;
  void syncEnps().then((r) => {
    if (!r.ok) console.error("[enps] background sync failed:", r.error);
  });
}
