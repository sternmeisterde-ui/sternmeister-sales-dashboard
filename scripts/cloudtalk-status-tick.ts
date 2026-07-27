// Разовый прогон тика присутствия CloudTalk (спека 26, Фаза 0).
// В проде это делает compose-сервис status-cron раз в минуту; скрипт нужен для
// первой проверки и для диагностики («а что вообще отдаёт CloudTalk сейчас?»).
//
// Запуск из корня репозитория:
//   npx tsx scripts/cloudtalk-status-tick.ts --dry            # только срез, без записи
//   npx tsx scripts/cloudtalk-status-tick.ts --force          # прогнать тик, игнорируя рубильник
//   npx tsx scripts/cloudtalk-status-tick.ts --env ../dialer/dialer-sync/.env
//
// Требует .env.local с TRACKING_DATABASE_URL + DATABASE_URL, а также
// CT_DASHBOARD_EMAIL / CT_DASHBOARD_PASSWORD_B64 — их можно подложить из другого
// env-файла флагом --env (креды CloudTalk-дашборда уже есть у dialer-sync).

import { config } from "dotenv";
import { resolve } from "node:path";
import dns from "node:dns";
import net from "node:net";

// IPv4-first как в src/instrumentation.ts: на сетях с битым IPv6 Neon-драйвер
// иначе виснет на AAAA-адресе до таймаута (см. memory neon-ipv6-hang).
dns.setDefaultResultOrder("ipv4first");
net.setDefaultAutoSelectFamily(true);
net.setDefaultAutoSelectFamilyAttemptTimeout(500);

config({ path: resolve(process.cwd(), ".env.local") });

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const value = (name: string): string | null => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : null;
};

const extraEnv = value("env");
if (extraEnv) {
  config({ path: resolve(process.cwd(), extraEnv), override: false });
  console.log(`[tick] подгружен доп. env: ${extraEnv}`);
}
if (flag("force")) process.env.CT_STATUS_SYNC_ENABLED = "1";

async function main() {
  const { fetchAgentPresence } = await import("../src/lib/telephony/cloudtalk-dashboard");

  const presence = await fetchAgentPresence();
  console.log(`\n=== СРЕЗ CLOUDTALK (${presence.length} агентов) ===`);
  const dist: Record<string, number> = {};
  for (const a of presence) {
    dist[a.status] = (dist[a.status] ?? 0) + 1;
    if (a.status !== "offline") {
      console.log(
        `  ${String(a.agentId).padEnd(8)} ${a.status.padEnd(8)} ` +
        `${a.idleName ?? (a.idleTypeId != null ? `id=${a.idleTypeId}` : "—")}`.padEnd(12) +
        ` ${a.fullName}`,
      );
    }
  }
  console.log("  распределение:", JSON.stringify(dist));

  if (flag("dry")) {
    console.log("\n--dry: запись пропущена");
    return;
  }

  const { syncCloudTalkStatuses } = await import("../src/lib/tracking/cloudtalk-status-sync");
  const result = await syncCloudTalkStatuses();
  console.log("\n=== ТИК ===");
  console.log(JSON.stringify(result, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[tick] упал:", err);
    process.exit(1);
  });
