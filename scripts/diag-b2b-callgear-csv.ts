// Диагностика №7: сверка кабинетной CSV-выгрузки CallGear (без фильтра по
// сотрудникам) с CallGear API за 29.06. Матч по «Идентификатор сессии звонка».
// READ-ONLY.
//
// Usage: npx tsx scripts/diag-b2b-callgear-csv.ts "<путь к csv>" [YMD]

import { config } from "dotenv";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
config({ path: resolve(process.cwd(), ".env.local") });

import dns from "node:dns";
dns.setDefaultResultOrder("ipv4first");

import { getCallsByDate } from "../src/lib/telephony/callgear";

const BERLIN = "Europe/Berlin";
const berlinDay = (d: Date) => d.toLocaleDateString("sv", { timeZone: BERLIN });

async function main() {
  const csvPath = process.argv[2] ?? "C:/Users/User/Downloads/report-call-29062026-29062026 (2).csv";
  const ymd = process.argv[3] ?? "2026-06-29";

  // ── Парсим CSV (utf8, ';', 4 строки шапки) ──
  const raw = readFileSync(csvPath, "utf8").replace(/^﻿/, "");
  const lines = raw.split(/\r?\n/).filter((l) => l.trim() !== "");
  const dataLines = lines.slice(4); // Отчет / Период / Общая длительность / заголовки колонок
  type CsvRow = { status: string; type: string; dt: string; emp: string; session: string };
  const rows: CsvRow[] = dataLines.map((l) => {
    const p = l.split(";");
    return { status: p[0], type: p[1], dt: p[2], emp: (p[8] ?? "").trim(), session: (p[12] ?? "").trim() };
  });

  console.log(`CSV: строк-обращений ${rows.length}`);
  const byEmp = new Map<string, { n: number; types: Map<string, number> }>();
  for (const r of rows) {
    const key = r.emp || "(без сотрудника)";
    const e = byEmp.get(key) ?? { n: 0, types: new Map() };
    e.n++;
    e.types.set(r.type, (e.types.get(r.type) ?? 0) + 1);
    byEmp.set(key, e);
  }
  console.log("\nCSV по сотрудникам (все типы):");
  for (const [emp, e] of [...byEmp.entries()].sort((a, b) => b[1].n - a[1].n)) {
    const t = [...e.types.entries()].map(([k, v]) => `${k}×${v}`).join(", ");
    console.log(`  ${emp.padEnd(35)} ${String(e.n).padStart(4)}  (${t})`);
  }

  // ── API за тот же день ──
  const fromUtc = new Date(`${ymd}T00:00:00+02:00`);
  const toUtcExcl = new Date(fromUtc.getTime() + 86_400_000);
  const api = await getCallsByDate(
    new Date(fromUtc.getTime() - 86_400_000),
    new Date(toUtcExcl.getTime() + 86_400_000),
  );
  const apiDay = api.filter((c) => berlinDay(c.startedAt) === ymd);

  // Сессии
  const csvSessions = new Set(rows.map((r) => r.session).filter(Boolean));
  const apiSessions = new Set(apiDay.map((c) => c.sessionId));
  const inBoth = [...csvSessions].filter((s) => apiSessions.has(s)).length;
  console.log(`\nСессии: CSV=${csvSessions.size} (уник.), API=${apiSessions.size} (уник., по легам ${apiDay.length})`);
  console.log(`  совпадают: ${inBoth}`);
  console.log(`  в CSV, но НЕТ в API: ${csvSessions.size - inBoth}`);
  const apiOnly = [...apiSessions].filter((s) => !csvSessions.has(s));
  console.log(`  в API, но НЕТ в CSV: ${apiOnly.length}`);

  // Сафронова: CSV vs API
  const safCsv = rows.filter((r) => r.emp.includes("Сафронова"));
  const safApi = apiDay.filter((c) => String(c.agentId) === "122116");
  console.log(`\nИрина Сафронова: CSV=${safCsv.length} обращений, API=${safApi.length} легов (сессий ${new Set(safApi.map((c) => c.sessionId)).size})`);
  const safCsvSessions = new Set(safCsv.map((r) => r.session));
  const safApiSessions = new Set(safApi.map((c) => c.sessionId));
  const safMissingInCsv = [...safApiSessions].filter((s) => !safCsvSessions.has(s));
  console.log(`  API-сессий Сафроновой, отсутствующих в CSV: ${safMissingInCsv.length}`);
  for (const s of safMissingInCsv.slice(0, 10)) {
    const c = safApi.find((x) => x.sessionId === s)!;
    console.log(`    session=${s}  ${c.startedAt.toISOString()}  ${c.type}  talk=${c.talkDurationSec}`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
