// Сверка «Длительности» CallGear за 26.06 с кабинетной выгрузкой (17 исх,
// итог 00:55:49 = 3349с). В БД cg: duration=talk, wait=total-talk →
// duration+wait должно повторить кабинетную «Длительность звонка». READ-ONLY.

import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });
import dns from "node:dns";
dns.setDefaultResultOrder("ipv4first");
import { neon } from "@neondatabase/serverless";
import { NAME_ALIASES } from "../src/lib/daily/name-aliases";

const fmt = (s: number) => `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

async function main() {
  const ymd = process.argv[2] ?? "2026-06-26";
  const fromUtc = new Date(`${ymd}T00:00:00+02:00`);
  const toUtcExcl = new Date(fromUtc.getTime() + 86_400_000);

  const d1 = neon(process.env.DATABASE_URL!);
  const masters = (await d1`
    SELECT name FROM master_managers
    WHERE department = 'b2b' AND is_active = true
      AND role IN ('manager', 'teamlead', 'rop')`) as Array<{ name: string }>;
  const names: string[] = [];
  for (const m of masters) {
    names.push(m.name);
    for (const a of NAME_ALIASES[m.name] ?? []) names.push(a);
  }

  const adb = neon(process.env.ANALYTICS_DATABASE_URL!);
  const rows = (await adb`
    SELECT DISTINCT ON (communication_id)
      communication_id, manager, duration, wait_seconds, created_at
    FROM analytics.communications
    WHERE created_at >= ${fromUtc.toISOString()} AND created_at < ${toUtcExcl.toISOString()}
      AND manager = ANY(${names})
      AND communication_type = 'call_out'
      AND communication_id LIKE 'cg-leg:%'
    ORDER BY communication_id, lead_id NULLS LAST
  `) as Array<{ communication_id: string; manager: string; duration: number | null; wait_seconds: number | null; created_at: string }>;

  let talk = 0, full = 0;
  for (const r of rows) {
    talk += Number(r.duration ?? 0);
    full += Number(r.duration ?? 0) + Number(r.wait_seconds ?? 0);
  }
  console.log(`CallGear исходящие МОПов за ${ymd} в БД: n=${rows.length}`);
  console.log(`  SUM(duration)          [прод сейчас]   = ${talk}с = ${fmt(talk)}`);
  console.log(`  SUM(duration+wait)     [PR #55]        = ${full}с = ${fmt(full)}`);
  console.log(`  Кабинет CallGear (выгрузка): 17 звонков, 00:55:49 = 3349с`);
  console.log(`\nТоп-3 по полной длительности (для глазной сверки с CSV):`);
  const sorted = [...rows].sort((a, b) => (Number(b.duration ?? 0) + Number(b.wait_seconds ?? 0)) - (Number(a.duration ?? 0) + Number(a.wait_seconds ?? 0)));
  for (const r of sorted.slice(0, 3)) {
    const f = Number(r.duration ?? 0) + Number(r.wait_seconds ?? 0);
    console.log(`  ${r.communication_id}  ${r.manager}  full=${fmt(f)} (talk=${r.duration}с, wait=${r.wait_seconds}с)  ${new Date(r.created_at).toISOString()}`);
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
