// Деактивация «осиротевшей» строки менеджера в OKK-базе (D2/R2 `managers`).
//
// Зачем: master_managers (D1) — единственный источник правды, и синк
// /api/managers гасит в таргетах только тех, кто В МАСТЕРЕ снят с флага.
// Строку, которой в мастере НЕТ вообще (заведена вручную/ботом в OKK-репо),
// синк не трогает — она остаётся is_active=true и висит в фильтрах вкладок,
// которые берут ростер из OKK-базы («Оценка критериев», ОКК). Так в фильтрах
// Коммерсов всплыла «Анна Винник» (2026-07-29; 0 звонков / 0 оценок).
//
// Soft-delete (is_active=false) — история звонков/оценок сохраняется.
//
// Запуск из корня репозитория:
//   npx tsx scripts/deactivate-orphan-okk-manager.ts --dept b2b --name "Анна Винник"
//   npx tsx scripts/deactivate-orphan-okk-manager.ts --dept b2b --name "Анна Винник" --apply
//
// Требует .env.local: R2_OKK_DATABASE_URL / D2_OKK_DATABASE_URL.
import { config } from "dotenv";
import { resolve } from "node:path";
import dns from "node:dns";
import net from "node:net";

// IPv4-first как в src/instrumentation.ts (см. memory neon-ipv6-hang).
dns.setDefaultResultOrder("ipv4first");
net.setDefaultAutoSelectFamily(true);
net.setDefaultAutoSelectFamilyAttemptTimeout(500);

config({ path: resolve(process.cwd(), ".env.local") });

import { neon } from "@neondatabase/serverless";

const args = process.argv.slice(2);
const argOf = (flag: string): string | null => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : null;
};
const APPLY = args.includes("--apply");
const DEPT = (argOf("--dept") ?? "b2b") as "b2b" | "b2g";
const NAME = argOf("--name");

async function main() {
  if (!NAME) {
    console.error('Укажите --name "Имя Фамилия" (опционально --dept b2b|b2g, --apply)');
    process.exit(1);
  }
  const url = DEPT === "b2b" ? process.env.R2_OKK_DATABASE_URL : process.env.D2_OKK_DATABASE_URL;
  if (!url) { console.error(`Нет коннекшена для ${DEPT}`); process.exit(1); }
  const okk = neon(url);

  const rows = await okk`SELECT id, name, is_active FROM managers WHERE name = ${NAME}`;
  if (rows.length === 0) { console.log(`В OKK-базе ${DEPT} нет менеджера «${NAME}» — нечего делать`); return; }
  const m = rows[0] as { id: string; name: string; is_active: boolean };
  console.log(`Найден: ${m.name} | id=${m.id} | is_active=${m.is_active}`);

  // Показываем историю: если она есть — это НЕ сирота, а обычный уволенный,
  // и деактивация всё равно безопасна (строки остаются), но стоит понимать.
  const calls = await okk`SELECT count(*) AS n FROM calls WHERE manager_id = ${m.id}`;
  const evals = await okk`SELECT count(*) AS n FROM evaluations WHERE manager_id = ${m.id}`;
  console.log(`  звонков: ${(calls[0] as { n: string }).n}, оценок: ${(evals[0] as { n: string }).n}`);

  if (!m.is_active) { console.log("Уже неактивен — нечего делать"); return; }
  if (!APPLY) { console.log("\nDRY-RUN. Для применения добавьте --apply"); return; }

  await okk`UPDATE managers SET is_active = false WHERE id = ${m.id}`;
  console.log("ПРИМЕНЕНО →", await okk`SELECT name, is_active FROM managers WHERE id = ${m.id}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
