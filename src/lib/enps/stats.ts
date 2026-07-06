/**
 * Агрегаты вкладки eNPS поверх D1 enps_responses.
 *
 * Все ответы анонимны — никаких разрезов по людям, только по неделям.
 * Классификация классическая eNPS: 9–10 промоутеры, 7–8 нейтралы,
 * 0–6 критики; eNPS = %промоутеров − %критиков.
 *
 * Объём данных крошечный (~10–15 ответов в неделю), поэтому выбираем период
 * одним SELECT и агрегируем в JS — гибче, чем SQL-группировка, и позволяет
 * отдать те же строки как анонимные цитаты без второго запроса.
 */

import { and, asc, eq, gte, lte, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { enpsResponses } from "@/lib/db/schema-existing";
import { APP_TZ, addDaysCivil, parseDateBoundary } from "@/lib/utils/date";
import { enpsSheetsConfigured } from "./sheets";

export interface EnpsWeekPoint {
  /** Понедельник берлинской ISO-недели, YYYY-MM-DD. */
  weekStart: string;
  count: number;
  avg: number;
  promoters: number;
  passives: number;
  detractors: number;
  /** −100..100, целое. */
  enps: number;
}

export interface EnpsResponseItem {
  submittedAt: string;
  weekStart: string;
  score: number;
  supports: string | null;
  frustrates: string | null;
}

export interface EnpsStats {
  available: boolean;
  syncConfigured: boolean;
  range: { from: string | null; to: string | null };
  totals: {
    count: number;
    avg: number | null;
    enps: number | null;
    promoters: number;
    passives: number;
    detractors: number;
  };
  weeks: EnpsWeekPoint[];
  /** Гистограмма оценок 0..10 за период. */
  distribution: { score: number; count: number }[];
  /** Все ответы периода (анонимные цитаты), новые сверху. */
  responses: EnpsResponseItem[];
  lastSubmittedAt: string | null;
  lastSyncedAt: string | null;
}

/** Понедельник берлинской недели, в которую попадает инстант. */
function berlinWeekStart(instant: Date): string {
  const civil = instant.toLocaleDateString("en-CA", { timeZone: APP_TZ });
  const [y, m, d] = civil.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sun
  return addDaysCivil(civil, -((dow + 6) % 7));
}

function classify(rows: { score: number }[]) {
  let promoters = 0;
  let passives = 0;
  let detractors = 0;
  for (const r of rows) {
    if (r.score >= 9) promoters += 1;
    else if (r.score >= 7) passives += 1;
    else detractors += 1;
  }
  const count = rows.length;
  return {
    count,
    promoters,
    passives,
    detractors,
    avg: count ? Math.round((rows.reduce((s, r) => s + r.score, 0) / count) * 100) / 100 : null,
    enps: count ? Math.round(((promoters - detractors) / count) * 100) : null,
  };
}

export async function getEnpsStats(opts: {
  department: string;
  from?: string | null;
  to?: string | null;
}): Promise<EnpsStats> {
  const conditions: SQL[] = [eq(enpsResponses.department, opts.department)];
  const fromBoundary = opts.from ? parseDateBoundary(opts.from, "start") : null;
  const toBoundary = opts.to ? parseDateBoundary(opts.to, "end") : null;
  if (fromBoundary) conditions.push(gte(enpsResponses.submittedAt, fromBoundary));
  if (toBoundary) conditions.push(lte(enpsResponses.submittedAt, toBoundary));

  const rows = await db
    .select({
      score: enpsResponses.score,
      supports: enpsResponses.supports,
      frustrates: enpsResponses.frustrates,
      submittedAt: enpsResponses.submittedAt,
      syncedAt: enpsResponses.syncedAt,
    })
    .from(enpsResponses)
    .where(and(...conditions))
    .orderBy(asc(enpsResponses.submittedAt));

  const byWeek = new Map<string, { score: number }[]>();
  for (const r of rows) {
    const week = berlinWeekStart(r.submittedAt);
    const bucket = byWeek.get(week);
    if (bucket) bucket.push(r);
    else byWeek.set(week, [r]);
  }

  const weeks: EnpsWeekPoint[] = [...byWeek.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([weekStart, weekRows]) => {
      const c = classify(weekRows);
      return {
        weekStart,
        count: c.count,
        avg: c.avg ?? 0,
        promoters: c.promoters,
        passives: c.passives,
        detractors: c.detractors,
        enps: c.enps ?? 0,
      };
    });

  const distribution = Array.from({ length: 11 }, (_, score) => ({
    score,
    count: rows.filter((r) => r.score === score).length,
  }));

  const lastSynced = rows.reduce<Date | null>(
    (max, r) => (r.syncedAt && (!max || r.syncedAt > max) ? r.syncedAt : max),
    null,
  );

  return {
    available: rows.length > 0,
    syncConfigured: enpsSheetsConfigured(),
    range: { from: opts.from ?? null, to: opts.to ?? null },
    totals: classify(rows),
    weeks,
    distribution,
    responses: rows
      .map((r) => ({
        submittedAt: r.submittedAt.toISOString(),
        weekStart: berlinWeekStart(r.submittedAt),
        score: r.score,
        supports: r.supports,
        frustrates: r.frustrates,
      }))
      .reverse(),
    lastSubmittedAt: rows.length ? rows[rows.length - 1].submittedAt.toISOString() : null,
    lastSyncedAt: lastSynced ? lastSynced.toISOString() : null,
  };
}
