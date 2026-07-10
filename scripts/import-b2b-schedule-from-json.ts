// Загружает JSON-манифест графика Коммерцов (B2B) — {name, date, status} —
// в manager_schedule. Манифест готовится scripts/parse-b2b-schedule-xlsx.py
// из листа "Sheet3" файла "Sternmeister расписание менеджеров (N).xlsx".
//
// status="work"  → is_on_line=true,  schedule_value="8"
// status="off"   → is_on_line=false, schedule_value="-"
//
// Идемпотентно: UPSERT по (user_id, schedule_date). Имена сверяются с
// активными менеджерами department='b2b' в master_managers; несовпавшие
// имена пропускаются (выводятся в консоль, ничего не пишется).
//
// Usage: npx tsx scripts/import-b2b-schedule-from-json.ts <manifest.json>
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });
import dns from "node:dns";
dns.setDefaultResultOrder("ipv4first");
import { readFileSync } from "node:fs";
import { neon } from "@neondatabase/serverless";

interface ManifestEntry {
  name: string;
  date: string; // YYYY-MM-DD
  status: "work" | "off";
}

async function main() {
  const manifestPath = process.argv[2];
  if (!manifestPath) {
    console.error("Usage: npx tsx scripts/import-b2b-schedule-from-json.ts <manifest.json>");
    process.exit(1);
  }
  const entries: ManifestEntry[] = JSON.parse(readFileSync(manifestPath, "utf-8"));

  const db = neon(process.env.DATABASE_URL!);
  const managers = await db`
    SELECT id, name FROM master_managers WHERE department = 'b2b' AND is_active = true
  `;
  const idByName = new Map<string, string>(managers.map((m) => [String(m.name).trim(), m.id as string]));

  const unmatched = new Set<string>();
  let written = 0;
  for (const e of entries) {
    const userId = idByName.get(e.name.trim());
    if (!userId) {
      unmatched.add(e.name);
      continue;
    }
    const isOnLine = e.status === "work";
    const scheduleValue = isOnLine ? "8" : "-";
    await db`
      INSERT INTO manager_schedule (user_id, schedule_date, is_on_line, schedule_value, updated_at)
      VALUES (${userId}::uuid, ${e.date}::date, ${isOnLine}, ${scheduleValue}, now())
      ON CONFLICT (user_id, schedule_date)
      DO UPDATE SET is_on_line = EXCLUDED.is_on_line, schedule_value = EXCLUDED.schedule_value, updated_at = now()
    `;
    written++;
  }

  if (unmatched.size > 0) {
    console.log("Имена без совпадения среди активных B2B-менеджеров (пропущены):", [...unmatched]);
  }
  console.log(`Записано ${written} из ${entries.length} строк.`);
}
main().catch((e) => { console.error(e); process.exit(1); });
