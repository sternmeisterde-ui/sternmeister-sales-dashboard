// Дымовой тест computeManagers (роль qualifier). ТОЛЬКО ЧТЕНИЕ.
//   npx tsx scripts/diag-managers-smoke.ts
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { computeManagers, type ManagerRoleKey } from "../src/lib/funnel/managers";

async function main(): Promise<void> {
  // Окно, где есть ОКК-данные (ОКК D2 стартовал в апреле).
  const from = new Date(Date.UTC(2026, 2, 1)); // 2026-03-01
  const to = new Date(Date.UTC(2026, 5, 9)); // 2026-06-09

  const t0 = Date.now();
  const res = await computeManagers({ from, to, maturity: "all", source: null, responsibleUserId: null });
  console.log(`Один проход (все роли): ${Date.now() - t0} ms`);

  for (const role of ["qualifier", "berater", "dovedenie"] as ManagerRoleKey[]) {
    const rows = res.roles[role];
    console.log(`\n===== Роль: ${role} (${rows.length} менеджеров) =====`);
    console.table(
      rows.map((r) => ({
        менеджер: r.name,
        линия: r.line ?? "—",
        клиенты: r.clients,
        "→Док": r.reachedDocs,
        "→ТерминДЦ": r.reachedTermDc,
        "→Гутшайн": r.reachedGutschein,
        "C5%": r.conversionC5Pct === null ? "—" : r.conversionC5Pct.toFixed(1),
        касания: r.touches,
        консульт: r.consultations,
        ОКК: r.avgOkk === null ? "—" : r.avgOkk,
        "ОКК_n": r.okkScored,
      }))
    );
  }
  console.log("\nГотово. Только чтение.");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("Ошибка:", e);
    process.exit(1);
  });
