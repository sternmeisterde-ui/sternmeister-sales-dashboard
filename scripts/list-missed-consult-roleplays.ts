/**
 * Список консультаций, которые ОКК НЕ разобрал как клиентскую ролевку, — для
 * добора ботом.
 *
 * Зачем отдельный скрипт в дашборде, а не выборка внутри ОКК: сторону ролевки
 * (ДЦ или АА) определяет ЭТАП СДЕЛКИ НА МОМЕНТ ЗВОНКА, а эта история живёт в
 * analytics.lead_status_changes — в базе ОКК её нет. Причина пропуска у таких
 * звонков тоже не помогает: в тексте ошибки стоит рубрика, которую ОКК ОТВЕРГ
 * (часто d2_qualifier), а не та, по которой звонок надо было разобрать.
 *
 * На выходе — файл «callId,side», который скармливается бэкфиллу ОКК:
 *   npx tsx scripts/backfill-client-roleplay.ts --apply --pairs-file=missed.csv
 *
 * ⚠ Только чтение. Grok не зовёт, в Kommo не ходит.
 *
 *   npx tsx scripts/list-missed-consult-roleplays.ts --from=2026-07-01 --to=2026-07-29 --out=missed.csv
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
const FROM = arg("from", "2026-07-01");
const TO = arg("to", "2026-07-29");
const OUT = arg("out", "");
const VERTICAL = arg("vertical", "buh") as "buh" | "med" | "all";

async function main() {
  const { sql } = await import("drizzle-orm");
  const { analyticsDb } = await import("../src/lib/db/analytics");
  const { d2OkkDb } = await import("../src/lib/db/okk");
  const { getBeraterPipelineIds, getBeraterStatusSets } = await import("../src/lib/kommo/pipeline-config");
  const { CONSULT_MIN_SECONDS } = await import("../src/lib/funnel/roleplays-section");
  const rows = (r: any) => (Array.isArray(r) ? r : r.rows) as any[];

  const beraterIds = getBeraterPipelineIds(VERTICAL);
  const br = getBeraterStatusSets(VERTICAL);
  const dcStatuses = [...br.consultBeforeDC, ...br.consultBeforeDCDone].map(Number);
  const aaStatuses = [...br.consultBeforeAA, ...br.consultBeforeAADone].map(Number);
  const consultStatuses = [...dcStatuses, ...aaStatuses];

  // Интервалы консультационных стадий — тот же расчёт, что во вкладке
  // «Ролевки»: от события смены статуса до следующего события по сделке.
  const stages = rows(await analyticsDb.execute(sql`
    WITH stage_ranges AS (
      SELECT lsc.lead_id,
             lsc.status_id,
             lsc.event_at,
             LEAD(lsc.event_at) OVER (PARTITION BY lsc.lead_id ORDER BY lsc.event_at) AS next_at
      FROM analytics.lead_status_changes lsc
      JOIN analytics.leads_cohort lc ON lc.lead_id = lsc.lead_id
      WHERE lc.pipeline_id IN (${sql.join(beraterIds.map((id) => sql`${id}`), sql`, `)})
        AND lc.is_deleted = FALSE
        AND lc.exclude_from_analytics = FALSE
    )
    -- Время отдаём эпохой в миллисекундах, а НЕ меткой времени: analytics
    -- хранит их без зоны, драйвер возвращает строку "2026-07-07 15:36:04", и
    -- new Date() трактует её как локальную. На машине в UTC+5 интервалы этапов
    -- уезжали на пять часов, и звонки молча выпадали из консультационного окна
    -- (43 разговора за июль, из них 17 — настоящие потерянные ролевки).
    SELECT lead_id, status_id,
           extract(epoch from event_at) * 1000 AS event_ms,
           extract(epoch from next_at) * 1000 AS next_ms
    FROM stage_ranges
    WHERE status_id IN (${sql.join(consultStatuses.map((id) => sql`${id}`), sql`, `)})
      AND (next_at IS NULL OR next_at >= ${FROM}::date)
      AND event_at < (${TO}::date + 1)
  `));
  const byLead = new Map<string, Array<{ statusId: number; from: number; to: number }>>();
  for (const s of stages) {
    const arr = byLead.get(String(s.lead_id)) ?? [];
    arr.push({
      statusId: Number(s.status_id),
      from: Number(s.event_ms),
      to: s.next_ms === null ? Number.POSITIVE_INFINITY : Number(s.next_ms),
    });
    byLead.set(String(s.lead_id), arr);
  }

  // Звонки ОКК за период: соединённые, от порога консультации, ещё без оценки
  // клиента. Первые половины склеенных пар пропускаем — разговор оценивается
  // на продолжении, и добор создал бы вторую ролевку на тот же день.
  // ⚠ ТОЛЬКО ЗВОНКИ БЕРАТЕРОВ (линия 2). Консультацию с ролевкой ведёт бератер;
  // квалификатор (линия 1) и доведение (линия 3) звонят тем же клиентам по
  // своим вопросам, и их разговоры на консультационном этапе — не консультации.
  // Без этого фильтра добор 29.07 создал 62 лишние клиентские ролевки, три из
  // которых бот даже оценил и записал в карточки.
  const calls = rows(await d2OkkDb.execute(sql`
    SELECT c.id, c.kommo_lead_id, c.call_created_at, c.duration_seconds,
           c.pair_role, c.error_message, COALESCE(c.transcript, '') <> '' AS has_transcript
    FROM calls c
    LEFT JOIN client_evaluations ce ON ce.call_id = c.id
    JOIN managers m ON m.id = c.manager_id AND m.line = '2'
    WHERE ce.call_id IS NULL
      AND c.kommo_lead_id IS NOT NULL
      AND COALESCE(c.duration_seconds, 0) >= ${CONSULT_MIN_SECONDS}
      AND ((c.call_created_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Berlin')::date
            BETWEEN ${FROM}::date AND ${TO}::date
      AND COALESCE(c.pair_role, '') <> 'primary'
    ORDER BY c.call_created_at
  `));

  // Уже разобранные ролевки: сделка + сторона + ДЕНЬ. Если день закрыт, второй
  // звонок того же дня добирать нельзя — в карточке слот один на разговор, и
  // добор создал бы вторую ролевку на ту же дату (ровно то, что мы чиним).
  const covered = new Set<string>();
  for (const r of rows(await d2OkkDb.execute(sql`
    SELECT ce.side,
           c.kommo_lead_id AS lead,
           ((c.call_created_at AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Berlin')::date::text AS day
    FROM client_evaluations ce
    JOIN calls c ON c.id = ce.call_id
    WHERE c.call_created_at IS NOT NULL
  `))) {
    covered.add(`${r.lead}|${r.side}|${r.day}`);
  }

  const out: Array<{ id: string; side: "dc" | "aa"; lead: string; day: string; reason: string; dur: number }> = [];
  const dropped = new Map<string, number>();
  const drop = (why: string) => dropped.set(why, (dropped.get(why) ?? 0) + 1);

  for (const c of calls) {
    const t = new Date(c.call_created_at).getTime();
    const stage = (byLead.get(String(c.kommo_lead_id)) ?? []).find((s) => t >= s.from && t < s.to);
    if (!stage) {
      drop("звонок вне консультационного этапа (или сделка не Бератер)");
      continue;
    }
    if (!c.has_transcript) {
      drop("нет транскрипта — сначала транскрибация");
      continue;
    }
    const side: "dc" | "aa" = dcStatuses.includes(stage.statusId) ? "dc" : "aa";
    const day = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Berlin",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(c.call_created_at));
    if (covered.has(`${c.kommo_lead_id}|${side}|${day}`)) {
      drop("этот день у сделки бот уже разобрал");
      continue;
    }
    out.push({
      id: String(c.id),
      side,
      lead: String(c.kommo_lead_id),
      day,
      reason: String(c.error_message ?? "").slice(0, 60) || "без пометки",
      dur: Number(c.duration_seconds ?? 0),
    });
  }

  // Один разговор — одна ролевка: из нескольких строк на день берём самую
  // длинную (в ней и есть содержательная часть консультации).
  const best = new Map<string, (typeof out)[number]>();
  for (const o of out) {
    const key = `${o.lead}|${o.side}|${o.day}`;
    const cur = best.get(key);
    if (!cur || o.dur > cur.dur) best.set(key, o);
  }
  const collapsed = out.length - best.size;
  if (collapsed > 0) drop(`несколько строк на один день — оставлена самая длинная (${collapsed})`);
  out.length = 0;
  out.push(...[...best.values()].sort((a, b) => a.day.localeCompare(b.day)));

  console.log(`Окно ${FROM}..${TO}, звонков ОКК без оценки клиента: ${calls.length}`);
  for (const [why, n] of [...dropped].sort((a, b) => b[1] - a[1])) console.log(`  отсеяно ${String(n).padStart(4)}  ${why}`);
  console.log(`\nК ДОБОРУ: ${out.length} (ДЦ ${out.filter((o) => o.side === "dc").length}, АА ${out.filter((o) => o.side === "aa").length})`);

  const byReason = new Map<string, number>();
  for (const o of out) {
    const key = /not allowed/.test(o.reason) ? "рубрика не совпала"
      : /stuck in evaluating|Evaluation failed/.test(o.reason) ? "сбой обработки"
      : /follow-up call on/.test(o.reason) ? "правило повторных"
      : /too short for/.test(o.reason) ? "короче порога"
      : o.reason === "без пометки" ? "без пометки" : "прочее";
    byReason.set(key, (byReason.get(key) ?? 0) + 1);
  }
  for (const [r, n] of [...byReason].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${r}`);

  if (args.includes("--debug")) {
    const raw = new Map<string, number>();
    for (const o of out) raw.set(o.reason, (raw.get(o.reason) ?? 0) + 1);
    console.log("\nсырые пометки ОКК (топ-15):");
    for (const [r, n] of [...raw].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
      console.log(`  ${String(n).padStart(4)}  ${r}`);
    }
  }

  if (OUT) {
    writeFileSync(OUT, out.map((o) => `${o.id},${o.side}`).join("\n") + "\n", "utf-8");
    console.log(`\nЗаписано в ${OUT}`);
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
