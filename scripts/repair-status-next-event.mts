// РЕМОНТ: фантомно-«открытые» строки analytics.lead_status_changes.
//
// Симптом: у строки next_event_at IS NULL, хотя у лида есть более позднее
// событие — оконный пересчёт стыков (см. src/lib/etl/sync-status-changes.ts)
// для этих лидов когда-то не отработал. Затронуто ~329 лидов с последними
// событиями февраля–апреля 2026 (диагностика 2026-07-07, вкладка «Регламент»:
// давно пройденные этапы выглядели вечно открытыми).
//
// Операция идемпотентна и повторяет штатный пересчёт ETL, но затрагивает
// ТОЛЬКО лидов с фантомами. ЗАПУСКАТЬ ПО СОГЛАСОВАНИЮ (пишет в прод Analytics):
//   npx tsx scripts/repair-status-next-event.mts
//
// Вкладка «Регламент» от ремонта не зависит (fetchStageIntervals фильтрует
// фантомы сама), но остальные читатели next_event_at/next_status_id — зависят.

import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.ANALYTICS_DATABASE_URL!);

const PHANTOM_COUNT = `
  SELECT COUNT(*) AS phantom FROM analytics.lead_status_changes a
  WHERE a.next_event_at IS NULL
    AND EXISTS (SELECT 1 FROM analytics.lead_status_changes b
                WHERE b.lead_id = a.lead_id AND b.event_at > a.event_at)`;

async function main() {
  const before = await sql.query(PHANTOM_COUNT);
  console.log("фантомных строк до:", before[0].phantom);

  await sql.query(`
    WITH bad_leads AS (
      SELECT DISTINCT a.lead_id FROM analytics.lead_status_changes a
      WHERE a.next_event_at IS NULL
        AND EXISTS (SELECT 1 FROM analytics.lead_status_changes b
                    WHERE b.lead_id = a.lead_id AND b.event_at > a.event_at)
    ), ordered AS (
      SELECT lead_id, status_id, event_at,
        MAX(event_at) OVER (PARTITION BY lead_id) AS last_event,
        LEAD(status_id) OVER (PARTITION BY lead_id ORDER BY event_at) AS next_sid,
        LEAD(event_at)  OVER (PARTITION BY lead_id ORDER BY event_at) AS next_eat
      FROM analytics.lead_status_changes
      WHERE lead_id IN (SELECT lead_id FROM bad_leads)
    )
    UPDATE analytics.lead_status_changes lsc
    SET last_event_at = o.last_event, next_status_id = o.next_sid, next_event_at = o.next_eat
    FROM ordered o
    WHERE lsc.lead_id = o.lead_id AND lsc.status_id = o.status_id AND lsc.event_at = o.event_at`);

  const after = await sql.query(PHANTOM_COUNT);
  console.log("фантомных строк после:", after[0].phantom);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
