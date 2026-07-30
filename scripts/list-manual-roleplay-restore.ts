/**
 * Готовит список правок для отката полей «Ролевка ДЦ/АА-N» к ручным значениям.
 *
 * Решение РОПа 30.07.2026: бот перестаёт писать баллы в карточки, всё им
 * записанное откатывается к тому, что вводили менеджеры.
 *
 * Источник истины — журнал событий Kommo (`tracking_events`): туда попадают
 * правки ЛЮДЕЙ и не попадают записи бота (синк тянет события только по
 * kommo_user_id менеджеров). Последнее значение слота в журнале = то, что
 * вводил человек.
 *
 * ⚠ Только чтение. Список скармливается скрипту записи в ОКК:
 *   npx tsx scripts/restore-manual-roleplay-scores.ts --file=restore.json
 *
 *   npx tsx scripts/list-manual-roleplay-restore.ts --out=restore.json
 */
import { config } from "dotenv";
import { resolve } from "node:path";
import { writeFileSync } from "node:fs";
import dns from "node:dns";
import net from "node:net";

dns.setDefaultResultOrder("ipv4first");
net.setDefaultAutoSelectFamily(true);
net.setDefaultAutoSelectFamilyAttemptTimeout(500);

config({ path: resolve(process.cwd(), ".env.local") });

const args = process.argv.slice(2);
const arg = (k: string, d: string) => {
  const a = args.find((x) => x.startsWith(`--${k}=`));
  return a ? a.slice(k.length + 3) : d;
};

type Side = "dc" | "aa";
type Row = Record<string, unknown>;

const SCORE_FIELDS: Record<string, { side: Side; attempt: number }> = {
  "891980": { side: "dc", attempt: 1 }, "891984": { side: "dc", attempt: 2 }, "891988": { side: "dc", attempt: 3 },
  "891992": { side: "aa", attempt: 1 }, "891996": { side: "aa", attempt: 2 }, "892000": { side: "aa", attempt: 3 },
};
const DATE_FIELDS: Record<string, { side: Side; attempt: number }> = {
  "891978": { side: "dc", attempt: 1 }, "891982": { side: "dc", attempt: 2 }, "891986": { side: "dc", attempt: 3 },
  "891990": { side: "aa", attempt: 1 }, "891994": { side: "aa", attempt: 2 }, "891998": { side: "aa", attempt: 3 },
};

async function main() {
  const out = arg("out", "");
  const { sql } = await import("drizzle-orm");
  const { analyticsDb } = await import("../src/lib/db/analytics");
  const { trackingDb } = await import("../src/lib/db/tracking-db");
  const rows = (r: unknown): Row[] =>
    (Array.isArray(r) ? r : ((r as { rows?: Row[] })?.rows ?? [])) as Row[];

  // Последнее РУЧНОЕ значение каждого слота.
  const human = new Map<string, { score: number | null; day: string | null }>();
  for (const e of rows(await trackingDb.execute(sql`
    SELECT entity_id, event_type, raw FROM tracking_events
    WHERE entity_type = 'lead' AND event_type LIKE 'custom_field_89%_value_changed'
    ORDER BY created_at`))) {
    const id = String(e.event_type).replace(/\D/g, "");
    const f = SCORE_FIELDS[id] ?? DATE_FIELDS[id];
    if (!f) continue;
    const key = `${e.entity_id}|${f.side}|${f.attempt}`;
    const raw = e.raw as { value_after?: Array<{ custom_field_value?: { text?: unknown } }> } | null;
    const txt = raw?.value_after?.[0]?.custom_field_value?.text;
    const cur = human.get(key) ?? { score: null, day: null };
    if (SCORE_FIELDS[id]) {
      const n = txt === undefined || txt === null || txt === "" ? NaN : Number(String(txt));
      cur.score = Number.isFinite(n) ? n : null;
    } else {
      // Kommo отдаёт наивную строку в TZ аккаунта — берём день как есть, без
      // new Date(): иначе он уедет на таймзону машины.
      cur.day = txt && /^\d{4}-\d{2}-\d{2}/.test(String(txt)) ? String(txt).slice(0, 10) : null;
    }
    human.set(key, cur);
  }

  // Что стоит в карточках сейчас (зеркало).
  const now = new Map<string, { score: number | null; day: string | null }>();
  for (const r of rows(await analyticsDb.execute(sql`
    SELECT lead_id, roleplay_slots FROM analytics.leads_cohort WHERE roleplay_slots IS NOT NULL`))) {
    for (const s of (r.roleplay_slots as Array<Record<string, unknown>>) ?? []) {
      now.set(`${r.lead_id}|${s.side}|${s.attempt}`, {
        score: s.score === null || s.score === undefined ? null : Number(s.score),
        day: s.date ? String(s.date) : null,
      });
    }
  }

  const changes: Array<Record<string, unknown>> = [];
  const keys = new Set([...human.keys(), ...now.keys()]);
  for (const key of keys) {
    const [leadStr, side, attemptStr] = key.split("|");
    const h = human.get(key);
    const c = now.get(key);
    const curScore = c?.score ?? null;
    const humanScore = h?.score ?? null;
    if (humanScore === curScore) continue;
    if (humanScore === null && curScore === null) continue;

    changes.push({
      leadId: Number(leadStr),
      side,
      attempt: Number(attemptStr),
      score: humanScore,
      day: humanScore === null ? null : (h?.day ?? c?.day ?? null),
      current: curScore,
      action: humanScore === null ? "clear" : "restore",
    });
  }

  const restore = changes.filter((c) => c.action === "restore").length;
  const clear = changes.length - restore;
  console.log(`слотов с ручной историей: ${human.size}, заполнено сейчас: ${[...now.values()].filter((s) => s.score !== null).length}`);
  console.log(`правок: ${changes.length} — вернуть ручной балл ${restore}, очистить ${clear}`);
  for (const c of changes.slice(0, 12)) {
    console.log(`  сделка ${c.leadId} ${c.side}-${c.attempt}: ${c.current ?? "пусто"} → ${c.action === "clear" ? "очистить" : c.score}`);
  }
  if (out) {
    writeFileSync(out, JSON.stringify(changes, null, 2), "utf-8");
    console.log(`\nЗаписано в ${out}`);
  } else {
    console.log("\n(--out=файл не задан — список не сохранён)");
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
