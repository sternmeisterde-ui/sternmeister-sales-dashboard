// ⛔ УЖЕ ПРИМЕНЕНО 2026-07-02 (через apply-cg-tz-shift-once.ts с маркером
// onetime-cg-tz-fix-20260702 в analytics.etl_locks). НЕ ЗАПУСКАТЬ.
// Файл сохранён как документация; формула ниже ИСПРАВЛЕНА (в версии из
// PR #57 сдвиг был в обратную сторону — колонка оказалась timestamp
// WITHOUT time zone, см. diag-tz-semantics.ts).
//
// Разовый фикс истории: cg-leg строки в analytics.communications записаны со
// временем «берлинская стенка как UTC» (CallGear отдаёт naive-время в поясе
// аккаунта = Europe/Berlin, а парсер трактовал его как UTC). Колонка
// created_at — timestamp WITHOUT time zone (naive, трактуется приложением
// как UTC). Значит стенка в колонке = берлинская, а истинный UTC:
//   (created_at AT TIME ZONE 'Europe/Berlin') AT TIME ZONE 'UTC'
// (naive-как-Берлин → timestamptz → naive-UTC-стенка; DST-aware в PG).
// Семантика проверена пробой diag-tz-semantics.ts: 18:57 → 16:57 (лето, −2ч).
//
// ⚠ НЕ ИДЕМПОТЕНТНО: повторный запуск сдвинет время ещё раз. Запускать РОВНО
// ОДИН РАЗ, ПОСЛЕ деплоя фикса парсера (feat/callgear-berlin-tz), с cutoff
// СТРОГО ДО момента деплоя минус 10ч (строки новее могли быть записаны уже
// исправленным кодом). Хвост cutoff..now добирается перезапуском
// backfill-from-telephony на последние 1-2 дня.
//
// Usage:
//   npx tsx scripts/fix-cg-created-at-tz.ts --cutoff 2026-07-02 --dry
//   npx tsx scripts/fix-cg-created-at-tz.ts --cutoff 2026-07-02 --apply

import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });
import dns from "node:dns";
dns.setDefaultResultOrder("ipv4first");
import { neon } from "@neondatabase/serverless";

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? "true") : null;
}

async function main() {
  const cutoffArg = arg("cutoff");
  const apply = process.argv.includes("--apply");
  if (!cutoffArg || cutoffArg === "true") throw new Error("нужен --cutoff YYYY-MM-DD (< деплоя парсер-фикса минус 10ч)");
  const cutoff = new Date(`${cutoffArg}T00:00:00Z`);
  if (Number.isNaN(cutoff.getTime())) throw new Error(`плохой cutoff: ${cutoffArg}`);

  const adb = neon(process.env.ANALYTICS_DATABASE_URL!);

  const stat = (await adb`
    SELECT COUNT(*) AS n, MIN(created_at) AS mn, MAX(created_at) AS mx
    FROM analytics.communications
    WHERE communication_id LIKE 'cg-leg:%' AND created_at < ${cutoff.toISOString()}
  `) as Array<{ n: string; mn: string; mx: string }>;
  console.log(`cg-leg строк до cutoff ${cutoffArg}: ${stat[0].n} (${stat[0].mn} .. ${stat[0].mx})`);

  const sample = (await adb`
    SELECT communication_id, created_at,
           ((created_at AT TIME ZONE 'Europe/Berlin') AT TIME ZONE 'UTC') AS fixed
    FROM analytics.communications
    WHERE communication_id LIKE 'cg-leg:%' AND created_at < ${cutoff.toISOString()}
    ORDER BY created_at DESC LIMIT 3`) as Array<Record<string, unknown>>;
  console.log("Примеры (было → станет, UTC):");
  for (const s of sample) console.log(`  ${s.communication_id}: ${s.created_at} → ${s.fixed}`);

  if (!apply) { console.log("\n--dry: изменений не вношу. Для применения добавь --apply"); return; }

  // Помесячные чанки, чтобы не упереться в таймаут Neon HTTP на одном UPDATE.
  let total = 0;
  for (let m = new Date("2026-01-01T00:00:00Z"); m < cutoff; m = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 1))) {
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
  console.log(`\n✓ всего обновлено ${total}. ПОВТОРНО НЕ ЗАПУСКАТЬ.`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
