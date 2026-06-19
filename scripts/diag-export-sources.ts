// Диагностика источников для выгрузки звонков (Фаза 0, часть 2).
//
// Проверяет весь путь данных БЕЗ записи куда-либо:
//   1. analytics: свежие B2B-лиды в статусах Рассрочка / Успешно реализовано
//      (WON) с датой платежа;
//   2. для одного — контакт (имя, телефоны) через lead_contact_links+contacts;
//   3. R2 OKK okk_calls: звонки этого лида/контакта — есть ли recordingUrl и
//      transcript;
//   4. пробует скачать одну запись сервером (Range 0-1023), проверяя доступ.
//
//   npx tsx scripts/diag-export-sources.ts

import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

// Локальный воркэраунд (только Windows-разработка): fetch (undici) пытается
// IPv6-адреса Neon, которые в некоторых сетях не маршрутизируются, и виснет до
// таймаута вместо фолбэка на IPv4. Отключаем Happy-Eyeballs и ставим IPv4
// первым — соединение идёт по IPv4. В прод-контейнере (Linux) этого бага нет,
// код фичи это НЕ трогает.
import net from "node:net";
import dns from "node:dns";
net.setDefaultAutoSelectFamily(false);
dns.setDefaultResultOrder("ipv4first");

import { sql } from "drizzle-orm";
import { analyticsDb } from "../src/lib/db/analytics";
import { getOkkDbForDepartment } from "../src/lib/db/okk";

// B2B won/installment статусы (см. src/lib/kommo/pipeline-config.ts)
const WON = 142;
const COMMERCIAL_INSTALLMENT = 82946499;
const MEDICAL_INSTALLMENT = 101858279;
const TARGET_STATUSES = [WON, COMMERCIAL_INSTALLMENT, MEDICAL_INSTALLMENT];
const B2B_PIPELINES = [10631243, 13209983];

async function main() {
  console.log("[1/4] Ищу свежие B2B-лиды в Рассрочка/Успешно реализовано…");
  const leads = await analyticsDb.execute<{
    lead_id: number; status_id: number; status: string;
    first_payment_date: string | null; prepayment_date: string | null;
  }>(sql`
    SELECT lead_id, status_id, status, first_payment_date, prepayment_date
    FROM analytics.leads_cohort
    WHERE pipeline_id IN (${sql.join(B2B_PIPELINES.map((p) => sql`${p}`), sql`, `)})
      AND status_id IN (${sql.join(TARGET_STATUSES.map((s) => sql`${s}`), sql`, `)})
      AND is_deleted = false
    ORDER BY COALESCE(first_payment_date, prepayment_date, created_at) DESC NULLS LAST
    LIMIT 20
  `);
  console.log(`   ✓ найдено ${leads.rows.length} (показываю до 5):`);
  for (const l of leads.rows.slice(0, 5)) {
    console.log(`     lead ${l.lead_id} | ${l.status} | оплата: ${l.first_payment_date ?? l.prepayment_date ?? "—"}`);
  }
  if (leads.rows.length === 0) { console.log("   нет данных — нечего проверять."); return; }

  // Берём первый лид, у которого есть привязанный контакт с телефоном.
  console.log("\n[2/4] Резолвлю контакт (имя + телефоны)…");
  let chosen: { leadId: number; name: string | null; phones: string[]; paymentDate: string | null } | null = null;
  for (const l of leads.rows) {
    const c = await analyticsDb.execute<{ name: string | null; phone: string | null; phones_all: unknown }>(sql`
      SELECT c.name, c.phone, c.phones_all
      FROM analytics.lead_contact_links lcl
      JOIN analytics.contacts c ON c.contact_id = lcl.contact_id
      WHERE lcl.lead_id = ${l.lead_id} AND lcl.is_active = true
      LIMIT 1
    `);
    const row = c.rows[0];
    if (!row) continue;
    const phones = new Set<string>();
    if (row.phone) phones.add(row.phone);
    if (Array.isArray(row.phones_all)) for (const p of row.phones_all) if (typeof p === "string") phones.add(p);
    if (phones.size === 0) continue;
    chosen = { leadId: l.lead_id, name: row.name, phones: [...phones], paymentDate: l.first_payment_date ?? l.prepayment_date };
    break;
  }
  if (!chosen) { console.log("   ⚠ ни у одного лида нет контакта с телефоном — проверь sync-contacts."); return; }
  console.log(`   ✓ lead ${chosen.leadId} | контакт: ${chosen.name ?? "—"} | телефоны: ${chosen.phones.join(", ")} | оплата: ${chosen.paymentDate ?? "—"}`);

  // Нормализация телефона для сравнения — только цифры, последние 10.
  const norm = (p: string) => p.replace(/\D/g, "").slice(-10);
  const phoneKeys = chosen.phones.map(norm).filter((p) => p.length >= 7);

  console.log("\n[3/4] Звонки этого лида/контакта в R2 okk_calls…");
  const okkDb = getOkkDbForDepartment("b2b");
  const calls = await okkDb.execute<{
    id: string; contact_phone: string | null; direction: string | null;
    call_created_at: string | null; recording_url: string | null;
    transcript: string | null; status: string | null; kommo_lead_id: string | null;
  }>(sql`
    SELECT id, contact_phone, direction, call_created_at, recording_url,
           transcript, status, kommo_lead_id
    FROM calls
    WHERE kommo_lead_id = ${String(chosen.leadId)}
       OR right(regexp_replace(coalesce(contact_phone,''), '\\D', '', 'g'), 10) IN (
            ${sql.join(phoneKeys.map((p) => sql`${p}`), sql`, `)}
          )
    ORDER BY call_created_at DESC
    LIMIT 50
  `);
  const withRec = calls.rows.filter((c) => c.recording_url);
  const withTr = calls.rows.filter((c) => c.transcript && c.transcript.length > 0);
  console.log(`   ✓ всего звонков: ${calls.rows.length} | с записью: ${withRec.length} | с транскриптом: ${withTr.length}`);
  for (const c of calls.rows.slice(0, 8)) {
    console.log(`     ${c.call_created_at ?? "—"} | ${c.direction ?? "?"} | rec:${c.recording_url ? "да" : "нет"} | tr:${c.transcript ? "да" : "нет"} | lead:${c.kommo_lead_id ?? "—"}`);
  }

  if (withRec.length === 0) { console.log("\n   ⚠ записей нет — проверим CallGear/CloudTalk отдельно."); return; }

  console.log("\n[4/4] Анализ ссылок на записи…");
  for (const c of withRec.slice(0, 3)) {
    try {
      const u = new URL(c.recording_url!);
      const hasQuery = u.search.length > 0;
      console.log(`   host: ${u.host} | path: ${u.pathname} | query: ${hasQuery ? "есть(скрыт)" : "нет"}`);
    } catch {
      console.log(`   (не URL): ${String(c.recording_url).slice(0, 60)}`);
    }
  }

  const url = withRec[0].recording_url!;
  const host = (() => { try { return new URL(url).host; } catch { return ""; } })();

  // Пробуем разные способы авторизации в зависимости от провайдера.
  const ctId = process.env.CLOUDTALK_API_ID;
  const ctSecret = process.env.CLOUDTALK_API_SECRET;
  const attempts: Array<{ label: string; headers: Record<string, string> }> = [
    { label: "без авторизации", headers: {} },
  ];
  if (ctId && ctSecret) {
    const basic = Buffer.from(`${ctId}:${ctSecret}`).toString("base64");
    attempts.push({ label: "CloudTalk Basic", headers: { Authorization: `Basic ${basic}` } });
  }
  const cgToken = process.env.CALLGEAR_ACCESS_TOKEN;
  if (cgToken) {
    attempts.push({ label: "CallGear ?access_token", headers: {} }); // токен в query — добавим ниже
  }

  for (const a of attempts) {
    let tryUrl = url;
    if (a.label.startsWith("CallGear") && cgToken) {
      tryUrl = url + (url.includes("?") ? "&" : "?") + "access_token=" + encodeURIComponent(cgToken);
    }
    try {
      const resp = await fetch(tryUrl, { headers: { Range: "bytes=0-1023", ...a.headers } });
      const buf = Buffer.from(await resp.arrayBuffer());
      const ct = resp.headers.get("content-type");
      const ok = resp.ok && buf.length > 0 && !!ct && ct.includes("audio");
      console.log(`   [${a.label}] статус ${resp.status} | ${ct} | ${buf.length}б ${ok ? "✅ АУДИО" : ""}`);
    } catch (e) {
      console.log(`   [${a.label}] ошибка: ${e instanceof Error ? e.message : e}`);
    }
  }
  console.log("\n   host записей:", host);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error("\n❌ Диагностика упала:", e instanceof Error ? e.stack : e);
  process.exit(1);
});
