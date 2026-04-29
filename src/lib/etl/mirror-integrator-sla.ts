/**
 * Mirror integrator's `sternmeister_sla.sla_start` into our analytics.sla.
 *
 * Why: integrator's sla_start = lead_created_at + ~3 min webhook lag for
 * fresh leads, but for older reactivated/transferred leads it shifts to
 * the actual moment a manager picked the lead up (can be days later).
 * Without mirroring, our compute-sla.ts uses lead_created_at always, so
 * calendar SLA values drift from the integrator's `SLA первого звонка
 * (тотал)` for old leads.
 *
 * Failure mode: this step is non-fatal — if integrator MySQL is down or
 * credentials missing, runSync logs and continues. SLA still ships with
 * our default sla_start (lead_created_at).
 *
 * Connection: 45.156.25.84:3306 (read-only `sternmeister` user).
 * Required env vars (all optional — step skipped if any missing):
 *   INTEGRATOR_MYSQL_HOST, INTEGRATOR_MYSQL_PORT, INTEGRATOR_MYSQL_USER,
 *   INTEGRATOR_MYSQL_PASS, INTEGRATOR_MYSQL_DB
 */

import { sql } from "drizzle-orm";
import { analyticsDb } from "@/lib/db/analytics";

export interface MirrorSlaResult {
  scanned: number;
  updated: number;
  skipped: "no-creds" | "no-rows" | "ok";
}

interface IntegratorSlaRow {
  lead_id: number | bigint;
  sla_start: Date | null;
}

export async function mirrorIntegratorSla(
  fromDate: Date,
  toDate: Date,
): Promise<MirrorSlaResult> {
  const host = process.env.INTEGRATOR_MYSQL_HOST;
  const user = process.env.INTEGRATOR_MYSQL_USER;
  const pass = process.env.INTEGRATOR_MYSQL_PASS;
  const db = process.env.INTEGRATOR_MYSQL_DB;
  if (!host || !user || !pass || !db) {
    console.log(
      "[ETL mirror-sla] skipped: INTEGRATOR_MYSQL_* env not set",
    );
    return { scanned: 0, updated: 0, skipped: "no-creds" };
  }
  const port = Number(process.env.INTEGRATOR_MYSQL_PORT ?? "3306");

  // mysql2/promise — dynamic import keeps it out of the bundle for routes
  // that don't touch this code path.
  const mysql = await import("mysql2/promise");
  const conn = await mysql.createConnection({
    host,
    port,
    user,
    password: pass,
    database: db,
    ssl: { rejectUnauthorized: false },
    connectTimeout: 15_000,
  });

  try {
    // Pull integrator's sla_start values for leads in our window.
    // Their `lead_created_at` is Berlin local naive; ours is UTC naive
    // (off by 2h CEST / 1h CET). Use a Berlin-converted comparison so the
    // window matches.
    const fromBerlin = new Date(fromDate.getTime()).toISOString().slice(0, 19).replace("T", " ");
    const toBerlin = new Date(toDate.getTime()).toISOString().slice(0, 19).replace("T", " ");
    const [rows] = await conn.execute<IntegratorSlaRow[] & import("mysql2").RowDataPacket[]>(
      `SELECT lead_id, sla_start
       FROM sternmeister_sla
       WHERE sla_start >= ?
         AND sla_start <= DATE_ADD(?, INTERVAL 1 DAY)
       LIMIT 100000`,
      [fromBerlin, toBerlin],
    );

    if (!rows || rows.length === 0) {
      console.log(
        `[ETL mirror-sla] window ${fromBerlin}..${toBerlin}: 0 integrator rows`,
      );
      return { scanned: 0, updated: 0, skipped: "no-rows" };
    }

    // Bulk update via VALUES: build CTE with (lead_id, sla_start_berlin),
    // then UPDATE analytics.sla. Berlin → UTC handled inline.
    const valuesSql = rows
      .map(
        (r) =>
          `(${Number(r.lead_id)}, '${r.sla_start instanceof Date
            ? r.sla_start.toISOString().slice(0, 19).replace("T", " ")
            : String(r.sla_start)}'::timestamp AT TIME ZONE 'Europe/Berlin' AT TIME ZONE 'UTC')`,
      )
      .join(", ");
    if (!valuesSql) {
      return { scanned: rows.length, updated: 0, skipped: "no-rows" };
    }

    const updateRes = await analyticsDb.execute<{ count: string }>(sql.raw(`
      WITH integrator(lead_id, sla_start_utc) AS (
        SELECT v.lead_id, v.sla_start_utc::timestamp
        FROM (VALUES ${valuesSql}) AS v(lead_id, sla_start_utc)
      ),
      upd AS (
        UPDATE analytics.sla AS our
        SET sla_start = i.sla_start_utc
        FROM integrator i
        WHERE our.lead_id = i.lead_id
          AND (our.sla_start IS DISTINCT FROM i.sla_start_utc)
        RETURNING 1
      )
      SELECT COUNT(*) AS count FROM upd
    `));
    const updated = Number(updateRes.rows[0]?.count ?? 0);
    console.log(
      `[ETL mirror-sla] window ${fromBerlin}..${toBerlin}: scanned=${rows.length} updated=${updated}`,
    );
    return { scanned: rows.length, updated, skipped: "ok" };
  } finally {
    await conn.end();
  }
}
