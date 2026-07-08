// Бэкфилл смен ответственного (Kommo events entity_responsible_changed по
// лидам) → analytics.lead_responsible_changes.
//
// Зачем: вкладка «Регламент» считает Время на этапах/TLT по периодам
// ответственности (документ РОПа, лист «ПРАВКИ» п.10-11/20/32) — при
// передаче лида отсчёт начинается заново.
//
// Запуск из корня (нужен .env.local):
//   npx tsx scripts/backfill-responsible-changes.ts                # с 2025-12-01
//   npx tsx scripts/backfill-responsible-changes.ts --from 2026-06-01
//
// Аккуратность к Kommo: свой троттлинг ≤1 rps (безопасно рядом с прод-кроном),
// ретраи на сетевые обрывы. Запись — upsert по event_id (идемпотентно).
// ВАЖНО: /events без filter[created_at] уходит в полный скан и висит — фильтр
// даты обязателен.

import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { getAuthHeaders, getBaseUrl } from "../src/lib/kommo/client";
import { analyticsDb } from "../src/lib/db/analytics";
import { leadResponsibleChanges } from "../src/lib/db/schema-analytics";
import { sql } from "drizzle-orm";

const RATE_MS = 1100;
let lastRequestAt = 0;
async function politeFetch(url: string, headers: HeadersInit): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    const wait = lastRequestAt + RATE_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastRequestAt = Date.now();
    try {
      const res = await fetch(url, { headers });
      if (res.status >= 500 && attempt < 4) {
        console.warn(`  HTTP ${res.status}, ретрай ${attempt}/3…`);
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
      return res;
    } catch (e) {
      if (attempt >= 4) throw e;
      console.warn(`  сеть: ${e instanceof Error ? e.message : e}, ретрай ${attempt}/3…`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

function arg(name: string, def: string | null = null): string | null {
  const a = process.argv.slice(2);
  const i = a.indexOf(`--${name}`);
  return i >= 0 && a[i + 1] && !a[i + 1].startsWith("--") ? a[i + 1] : def;
}

interface RawEvent {
  id: string;
  entity_id: number;
  entity_type: string;
  created_at: number;
  value_after?: Array<{ responsible_user?: { id?: number } }> | null;
  value_before?: Array<{ responsible_user?: { id?: number } }> | null;
}

async function main() {
  const fromStr = arg("from", "2025-12-01")!;
  const toStr = arg("to");
  const from = Math.floor(new Date(`${fromStr}T00:00:00Z`).getTime() / 1000);
  const to = toStr ? Math.floor(new Date(`${toStr}T23:59:59Z`).getTime() / 1000) : Math.floor(Date.now() / 1000);
  console.log(`[backfill-resp] окно created_at: ${fromStr} … ${toStr ?? "now"}`);

  const started = Date.now();
  const baseUrl = await getBaseUrl();
  const headers = await getAuthHeaders();
  const rows: (typeof leadResponsibleChanges.$inferInsert)[] = [];
  let requests = 0;
  for (let page = 1; ; page++) {
    const url = new URL(`${baseUrl}/events`);
    url.searchParams.set("limit", "100");
    url.searchParams.set("page", String(page));
    url.searchParams.set("filter[type]", "entity_responsible_changed");
    url.searchParams.set("filter[entity]", "lead");
    url.searchParams.set("filter[created_at][from]", String(from));
    url.searchParams.set("filter[created_at][to]", String(to));
    const res = await politeFetch(url.toString(), headers);
    requests++;
    if (res.status === 204) break;
    if (!res.ok) throw new Error(`Kommo /events page ${page}: HTTP ${res.status}`);
    const data = (await res.json()) as { _embedded?: { events?: RawEvent[] } };
    const batch = data._embedded?.events ?? [];
    for (const e of batch) {
      if (e.entity_type !== "lead") continue;
      rows.push({
        eventId: e.id,
        leadId: e.entity_id,
        eventAt: new Date(e.created_at * 1000),
        oldUserId: e.value_before?.[0]?.responsible_user?.id ?? null,
        newUserId: e.value_after?.[0]?.responsible_user?.id ?? null,
      });
    }
    if (page % 10 === 0 || batch.length < 100) console.log(`  страница ${page}: всего ${rows.length}`);
    if (batch.length < 100) break;
  }

  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    await analyticsDb
      .insert(leadResponsibleChanges)
      .values(rows.slice(i, i + CHUNK))
      .onConflictDoUpdate({
        target: leadResponsibleChanges.eventId,
        set: {
          leadId: sql`EXCLUDED.lead_id`,
          eventAt: sql`EXCLUDED.event_at`,
          oldUserId: sql`EXCLUDED.old_user_id`,
          newUserId: sql`EXCLUDED.new_user_id`,
        },
      });
  }
  console.log(
    `[backfill-resp] готово: ${rows.length} смен, ${requests} запросов за ${((Date.now() - started) / 1000).toFixed(1)}с`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
