// Разовый драйнер enrichment-бэклога после июньского бэкфилла телефонии
// (backfill-from-telephony 2026-05-31..2026-07-02 перезалил ~43k строк
// «сырыми», их надо заново привязать к лидам). Крутит enrichTelephonyLeads
// по окну с 31 мая до пустого бэклога. Кап ~200 строк/тик, ~100с/тик →
// весь бэклог ~35-40k строк ≈ 3-5 часов. Идемпотентно, безопасно рядом с
// прод-кроном (общий Kommo-лимитер жёстко ограничен, худшее — чуть
// медленнее тики).
//
// Usage: npx tsx scripts/drain-enrich-june.ts

import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });
import dns from "node:dns";
dns.setDefaultResultOrder("ipv4first");

import { enrichTelephonyLeads } from "../src/lib/etl/enrich-telephony-leads";

const FROM = new Date("2026-05-30T22:00:00Z"); // 31 мая 00:00 Berlin
const SAFETY_MAX_TICKS = 400; // 400 × ~200 строк = 80k — с запасом
const NO_PROGRESS_LIMIT = 3;  // подряд тиков без прогресса → стоп

async function main(): Promise<void> {
  const startMs = Date.now();
  let totalLinked = 0, totalFanned = 0, noProgress = 0;

  for (let tick = 1; tick <= SAFETY_MAX_TICKS; tick++) {
    const toDate = new Date();
    const res = await enrichTelephonyLeads(FROM, toDate);
    totalLinked += res.rowsLinked;
    totalFanned += res.rowsFannedOut;
    const mins = ((Date.now() - startMs) / 60000).toFixed(1);
    console.log(
      `[drain-june] tick ${tick}: scanned=${res.scannedRows} linked=${res.rowsLinked} fanned=${res.rowsFannedOut} ` +
      `unresolved=${res.unresolvedPhones.length} backlog=${res.backlogRemaining} | всего linked=${totalLinked} fanned=${totalFanned} | ${mins} мин`,
    );
    if (res.backlogRemaining === 0) {
      console.log(`[drain-june] ✓ бэклог пуст за ${mins} мин`);
      return;
    }
    if (res.rowsLinked === 0 && res.rowsFannedOut === 0) {
      noProgress += 1;
      if (noProgress >= NO_PROGRESS_LIMIT) {
        console.log(
          `[drain-june] стоп: ${NO_PROGRESS_LIMIT} тика без прогресса, остаток ${res.backlogRemaining} — ` +
          `видимо, телефоны без Kommo-контактов (легитимный остаток, уйдёт в skip-list)`,
        );
        return;
      }
    } else {
      noProgress = 0;
    }
  }
  console.log(`[drain-june] достигнут SAFETY_MAX_TICKS=${SAFETY_MAX_TICKS} — перезапусти скрипт`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
