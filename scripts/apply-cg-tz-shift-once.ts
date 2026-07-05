// Однократный (САМОЗАЩИЩЁННЫЙ) пересчёт created_at для cg-leg строк:
// «берлинская стенка как UTC» → истинный UTC. Одобрено владельцем трижды
// (2026-07-02). В отличие от fix-cg-created-at-tz.ts, здесь встроена защита
// от повторного запуска: маркер в analytics.etl_locks — если он уже есть,
// скрипт завершается БЕЗ каких-либо изменений. Двойной сдвиг невозможен.
//
// Формула (колонка timestamp WITHOUT time zone, приложение трактует как UTC):
//   created_at = (created_at AT TIME ZONE 'Europe/Berlin') AT TIME ZONE 'UTC'
// Семантика проверена diag-tz-semantics.ts (18:57 → 16:57, лето −2ч; зима −1ч
// автоматически). Cutoff 2026-07-02T00:00Z: строки новее могли быть записаны
// уже исправленным парсером (PR #57), их не трогаем — добор бэкфиллом.

import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });
import dns from "node:dns";
dns.setDefaultResultOrder("ipv4first");
import { neon } from "@neondatabase/serverless";

const MARKER = "onetime-cg-tz-fix-20260702";
const CUTOFF = "2026-07-02T00:00:00Z";

async function main() {
  const adb = neon(process.env.ANALYTICS_DATABASE_URL!);

  // ── Защита от повторного запуска ──
  const existing = await adb`SELECT name, last_completed_at FROM analytics.etl_locks WHERE name = ${MARKER}`;
  if (existing.length > 0) {
    console.log(`СТОП: фикс уже выполнялся (${JSON.stringify(existing[0])}). Изменения НЕ внесены.`);
    return;
  }
  // CHECK etl_locks_expires_after_acquired требует expires_at > acquired_at
  await adb`
    INSERT INTO analytics.etl_locks (name, token, acquired_at, expires_at)
    VALUES (${MARKER}, 'applied', now(), now() + interval '1 second')`;
  console.log(`Маркер ${MARKER} установлен — повторный запуск будет отклонён.`);

  // ── Помесячные чанки ──
  const cutoff = new Date(CUTOFF);
  let total = 0;
  for (let m = new Date("2025-11-01T00:00:00Z"); m < cutoff; m = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 1))) {
    const next = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 1));
    const hi = next < cutoff ? next : cutoff;
    const res = (await adb`
      UPDATE analytics.communications
      SET created_at = (created_at AT TIME ZONE 'Europe/Berlin') AT TIME ZONE 'UTC'
      WHERE communication_id LIKE 'cg-leg:%'
        AND created_at >= ${m.toISOString()} AND created_at < ${hi.toISOString()}
    `) as unknown as { rowCount?: number };
    const n = Number((res as { rowCount?: number }).rowCount ?? 0);
    total += n;
    console.log(`  ${m.toISOString().slice(0, 7)}: обновлено ${n}`);
  }

  await adb`UPDATE analytics.etl_locks SET last_completed_at = now() WHERE name = ${MARKER}`;
  console.log(`\n✓ всего обновлено ${total}. Маркер зафиксирован — повторный сдвиг невозможен.`);

  // Контроль: свежайшая строка до cutoff должна теперь быть −2ч от прежней
  const check = await adb`
    SELECT communication_id, created_at FROM analytics.communications
    WHERE communication_id LIKE 'cg-leg:%' AND created_at < ${CUTOFF}
    ORDER BY created_at DESC LIMIT 2`;
  console.log("Контроль (свежайшие строки после фикса):", JSON.stringify(check));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
