// WP1 шаг 1 — разведка Kommo-полей ролей менеджера (ТОЛЬКО ЧТЕНИЕ).
// Какой shape у значений полей сделки:
//   893575 «Менеджер Доведения», 891608 «Перевёл в Термин ДЦ», 893153 «Ответственный по сделке».
// Нужно понять тип значения (id пользователя? имя? enum_id?) → тип колонок миграции 0025.
//
//   npx tsx scripts/diag-manager-role-fields.ts

import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

import { getLeads } from "../src/lib/kommo/client";

const FIELDS = {
  893575: "Менеджер Доведения",
  891608: "Перевёл в Термин ДЦ",
  893153: "Ответственный по сделке",
} as const;
const FIELD_IDS = Object.keys(FIELDS).map(Number);

async function main(): Promise<void> {
  // Последние ~45 дней по дате обновления — больше шансов поймать заполненные поля.
  const now = Math.floor(Date.now() / 1000);
  const from = now - 45 * 24 * 3600;

  const leads = await getLeads(
    undefined,
    undefined,
    500,
    { field: "updated_at", from, to: now },
    false,
  );
  console.log(`Получено лидов: ${leads.length}`);

  // Счётчики заполненности + примеры сырых value-объектов по каждому полю.
  const stats = new Map<number, { populated: number; samples: unknown[] }>();
  for (const id of FIELD_IDS) stats.set(id, { populated: 0, samples: [] });

  for (const lead of leads) {
    const cf = lead.custom_fields_values as
      | Array<{ field_id: number; field_name?: string; values: unknown[] }>
      | null;
    if (!cf) continue;
    for (const id of FIELD_IDS) {
      const f = cf.find((x) => x.field_id === id);
      if (f && Array.isArray(f.values) && f.values.length > 0) {
        const s = stats.get(id)!;
        s.populated += 1;
        if (s.samples.length < 4) {
          s.samples.push({ field_name: f.field_name, values: f.values });
        }
      }
    }
  }

  for (const id of FIELD_IDS) {
    const s = stats.get(id)!;
    console.log(`\n=== ${id} «${FIELDS[id as keyof typeof FIELDS]}» ===`);
    console.log(`заполнено: ${s.populated} / ${leads.length}`);
    for (const sample of s.samples) {
      console.log("  raw:", JSON.stringify(sample));
    }
  }

  console.log("\nГотово. Только чтение.");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("Ошибка:", e);
    process.exit(1);
  });
