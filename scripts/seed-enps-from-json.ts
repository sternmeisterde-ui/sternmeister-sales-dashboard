/**
 * Разовый сид enps_responses из JSON-выгрузки xlsx-копии Google-таблицы eNPS.
 *
 * Нужен пока сервис-аккаунту не расшарили живую таблицу — после этого данные
 * держит в актуальном состоянии синк (src/lib/enps/sync.ts), а повторный
 * прогон сида безвреден: upsert по тому же token.
 *
 * Формат входного JSON: [{ token, score, supports, frustrates, submittedAt }]
 * (submittedAt — naive-строка из листа, Typeform пишет UTC).
 *
 * Запуск: npx tsx scripts/seed-enps-from-json.ts <путь-к-json>
 */

import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";

async function main() {
  const jsonPath = process.argv[2];
  if (!jsonPath) {
    console.error("Usage: npx tsx scripts/seed-enps-from-json.ts <path-to-json>");
    process.exit(1);
  }

  // Импорты после config(): db читает DATABASE_URL на первом обращении.
  const { db } = await import("../src/lib/db");
  const { upsertEnpsRows } = await import("../src/lib/enps/sync");

  // Идемпотентный DDL — зеркалит drizzle/d1/0003_enps_responses.sql,
  // чтобы сид работал и до ручного применения миграции.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS public.enps_responses (
      id           SERIAL PRIMARY KEY,
      department   TEXT NOT NULL DEFAULT 'b2g',
      token        TEXT NOT NULL UNIQUE,
      score        INTEGER NOT NULL,
      supports     TEXT,
      frustrates   TEXT,
      submitted_at TIMESTAMPTZ NOT NULL,
      synced_at    TIMESTAMPTZ DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS enps_responses_submitted_idx
      ON public.enps_responses (department, submitted_at)
  `);

  const raw = JSON.parse(readFileSync(jsonPath, "utf8")) as Array<{
    token: string;
    score: number;
    supports: string | null;
    frustrates: string | null;
    submittedAt: string;
  }>;

  const rows = raw
    .filter((r) => r.token && Number.isFinite(r.score) && r.submittedAt)
    .map((r) => ({
      token: r.token,
      score: Math.round(r.score),
      supports: r.supports?.trim() || null,
      frustrates: r.frustrates?.trim() || null,
      // naive UTC из листа → инстант
      submittedAt: new Date(`${r.submittedAt.replace(" ", "T")}${r.submittedAt.endsWith("Z") ? "" : "Z"}`),
    }))
    .filter((r) => !Number.isNaN(r.submittedAt.getTime()));

  const upserted = await upsertEnpsRows(rows);
  console.log(`Read ${raw.length} rows, upserted ${upserted} (skipped ${raw.length - upserted}).`);

  const check = await db.execute(sql`
    SELECT count(*)::int AS n, min(submitted_at) AS first, max(submitted_at) AS last
    FROM public.enps_responses WHERE department = 'b2g'
  `);
  console.log("Table state:", check.rows[0]);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
