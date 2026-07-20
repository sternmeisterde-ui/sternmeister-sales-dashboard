// Ручной прогон синка графика смен B2B (Google-файл РОПа → manager_schedule).
// Обычно выполняется шагом крона (runSync); скрипт — для первого прогона и
// отладки после правок файла.
//
// Run from repo root:
//   npx tsx scripts/sync-b2b-schedule.ts                # текущий+будущие месяцы
//   npx tsx scripts/sync-b2b-schedule.ts --allow-past   # + переписать прошлые месяцы из файла
//
// --allow-past нужен для осознанной ретро-правки истории (обычный синк
// прошедшие месяцы игнорирует, защищая базу от воркфлоу «РОП переписывает
// тот же блок под новый месяц»). После ретро-правки прошлых месяцев не
// забудь recompute-sla за тот период.
//
// Requires .env.local: DATABASE_URL, GOOGLE_OAUTH_JSON
// (+ опционально B2B_SCHEDULE_SPREADSHEET_ID).

import { config } from "dotenv";
import { resolve } from "node:path";
import dns from "node:dns";
import net from "node:net";

// IPv4-first как в src/instrumentation.ts: на сетях с битым IPv6 Neon-драйвер
// иначе виснет ~10с на AAAA-адресе до таймаута (см. memory neon-ipv6-hang).
dns.setDefaultResultOrder("ipv4first");
net.setDefaultAutoSelectFamily(true);
net.setDefaultAutoSelectFamilyAttemptTimeout(500);

config({ path: resolve(process.cwd(), ".env.local") });

import { syncB2bSchedule } from "../src/lib/etl/sync-b2b-schedule";

syncB2bSchedule({ allowPastMonths: process.argv.includes("--allow-past") })
  .then((res) => {
    console.log("Готово:", JSON.stringify(res, null, 2));
    process.exit(0);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
