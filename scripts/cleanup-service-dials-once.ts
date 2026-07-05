// Однократная (САМОЗАЩИЩЁННАЯ) чистка служебных наборов из analytics:
// исходящие телефонии на номера короче 6 цифр (типа «88» — голосовая
// почта/функции АТС). Кабинеты телефоний такие «звонки» не показывают —
// после чистки счётчики CallGear сходятся с кабинетом поштучно.
// Спека 22 п.10, решение владельца 2026-07-02. По подсчёту diag-service-
// dials.ts: 185 звонков (198 строк с fanout-копиями), все CallGear.
//
// Маркер в analytics.etl_locks защищает от повторного запуска (хотя DELETE
// и так идемпотентен — маркер для аудита и симметрии с tz-фиксом).

import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });
import dns from "node:dns";
dns.setDefaultResultOrder("ipv4first");
import { neon } from "@neondatabase/serverless";

const MARKER = "onetime-service-dials-cleanup-20260702";

async function main() {
  const adb = neon(process.env.ANALYTICS_DATABASE_URL!);

  const existing = await adb`SELECT name, last_completed_at FROM analytics.etl_locks WHERE name = ${MARKER}`;
  if (existing.length > 0) {
    console.log(`СТОП: чистка уже выполнялась (${JSON.stringify(existing[0])}).`);
    return;
  }

  const before = (await adb`
    SELECT COUNT(*) AS rows_n, COUNT(DISTINCT communication_id) AS calls_n
    FROM analytics.communications
    WHERE communication_type = 'call_out'
      AND (communication_id LIKE 'cg-leg:%' OR communication_id LIKE 'ct:%')
      AND length(regexp_replace(COALESCE(phone, ''), '\\D', '', 'g')) < 6
  `) as Array<{ rows_n: string; calls_n: string }>;
  console.log(`К удалению: ${before[0].calls_n} звонков (${before[0].rows_n} строк с копиями)`);

  await adb`
    INSERT INTO analytics.etl_locks (name, token, acquired_at, expires_at)
    VALUES (${MARKER}, 'applied', now(), now() + interval '1 second')`;

  await adb`
    DELETE FROM analytics.communications
    WHERE communication_type = 'call_out'
      AND (communication_id LIKE 'cg-leg:%' OR communication_id LIKE 'ct:%')
      AND length(regexp_replace(COALESCE(phone, ''), '\\D', '', 'g')) < 6`;

  await adb`UPDATE analytics.etl_locks SET last_completed_at = now() WHERE name = ${MARKER}`;

  const after = (await adb`
    SELECT COUNT(*) AS n FROM analytics.communications
    WHERE communication_type = 'call_out'
      AND (communication_id LIKE 'cg-leg:%' OR communication_id LIKE 'ct:%')
      AND length(regexp_replace(COALESCE(phone, ''), '\\D', '', 'g')) < 6
  `) as Array<{ n: string }>;
  console.log(`✓ готово, осталось таких строк: ${after[0].n}. Маркер ${MARKER} зафиксирован.`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
