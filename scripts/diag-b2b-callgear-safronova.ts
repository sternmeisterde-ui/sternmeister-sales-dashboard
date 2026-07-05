// Диагностика №6: чьи это 59 исходящих, которых нет в кабинетной выгрузке
// CallGear за 29.06? Проверяем employee 122116 (Сафронова?) и TZ. READ-ONLY.

import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import dns from "node:dns";
dns.setDefaultResultOrder("ipv4first");

import { getCallsByDate, getEmployees } from "../src/lib/telephony/callgear";

const BERLIN = "Europe/Berlin";
const berlinDay = (d: Date) => d.toLocaleDateString("sv", { timeZone: BERLIN });

async function main() {
  const ymd = process.argv[2] ?? "2026-06-29";
  const fromUtc = new Date(`${ymd}T00:00:00+02:00`);
  const toUtcExcl = new Date(fromUtc.getTime() + 86_400_000);

  // Кто есть кто в CallGear
  const employees = await getEmployees();
  const interesting = employees.filter((e) =>
    [122116, 94531, 123718, 121567].includes(Number(e.id)),
  );
  console.log("CallGear-справочник сотрудников (интересующие id):");
  for (const e of interesting) console.log(`  id=${e.id}  «${e.full_name}»  email=${e.email ?? "—"}  status=${e.status ?? "—"}`);

  const raw = await getCallsByDate(
    new Date(fromUtc.getTime() - 86_400_000),
    new Date(toUtcExcl.getTime() + 86_400_000),
  );
  const day = raw.filter((c) => berlinDay(c.startedAt) === ymd);

  // Все леги employee 122116 за день — как их видит API
  const saf = day.filter((c) => String(c.agentId) === "122116");
  console.log(`\nЛеги employee_id=122116 за ${ymd} (Berlin-бакет): ${saf.length}`);
  for (const c of saf.slice(0, 15)) {
    console.log(`  ${c.externalId}  «${c.agentName}»  ${c.type}  start=${c.startedAt.toISOString()}  talk=${c.talkDurationSec}s  phone=${c.phone}  virt=${c.virtualPhone}`);
  }

  // TZ-сверка: последний звонок Байды в кабинете — 19:34:32. Что у API?
  const baida = day
    .filter((c) => String(c.agentId) === "123718" && c.type === "outgoing")
    .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
  console.log(`\nЗвонки Байды (id=123718) за день, как их отдаёт API (сырое start_time трактуем как UTC):`);
  for (const c of baida) console.log(`  ${c.startedAt.toISOString()}  talk=${c.talkDurationSec}s  phone=${c.phone}`);

  // Виртуальные номера Сафроновой vs остальных — вдруг другая «площадка»
  const virtCount = new Map<string, number>();
  for (const c of saf) virtCount.set(c.virtualPhone || "—", (virtCount.get(c.virtualPhone || "—") ?? 0) + 1);
  console.log("\nВиртуальные номера в легах 122116:", Object.fromEntries(virtCount));
  const others = day.filter((c) => ["123718", "121567", "123727"].includes(String(c.agentId)));
  const virtOthers = new Map<string, number>();
  for (const c of others) virtOthers.set(c.virtualPhone || "—", (virtOthers.get(c.virtualPhone || "—") ?? 0) + 1);
  console.log("Виртуальные номера Байда/Пуховская/Лигай:", Object.fromEntries(virtOthers));
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
