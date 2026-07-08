// Смены ответственного по лидам (Kommo events entity_responsible_changed)
// → analytics.lead_responsible_changes.
//
// Зачем: вкладка «Регламент» считает «Время на этапах»/TLT/SLA по ПЕРИОДАМ
// ОТВЕТСТВЕННОСТИ (документ РОПа, лист «ПРАВКИ» п.10-11/20/32) — при передаче
// лида отсчёт начинается заново, проверка приписывается владельцу периода.
// История заполнена scripts/backfill-responsible-changes.ts (с 2025-12-01);
// этот шаг поддерживает свежесть в инкрементальном кроне.
//
// ВАЖНО: /events без filter[created_at] уходит в полный скан и висит вечно —
// фильтр даты обязателен.

import { rateLimitedFetch, getAuthHeaders, getBaseUrl } from "@/lib/kommo/client";
import { analyticsDb } from "@/lib/db/analytics";
import { leadResponsibleChanges } from "@/lib/db/schema-analytics";
import { sql } from "drizzle-orm";

interface RawEvent {
  id: string;
  entity_id: number;
  entity_type: string;
  created_at: number;
  value_after?: Array<{ responsible_user?: { id?: number } }> | null;
  value_before?: Array<{ responsible_user?: { id?: number } }> | null;
}

/**
 * Синк смен ответственного за окно [fromDate, toDate]. Идемпотентен
 * (upsert по event_id — natural key Kommo-события). Возвращает число строк.
 */
export async function syncResponsibleChanges(fromDate: Date, toDate: Date): Promise<number> {
  const from = Math.floor(fromDate.getTime() / 1000);
  const to = Math.floor(toDate.getTime() / 1000);
  const baseUrl = await getBaseUrl();
  const headers = await getAuthHeaders();

  const rows: (typeof leadResponsibleChanges.$inferInsert)[] = [];
  for (let page = 1; page <= 200; page++) {
    const url = new URL(`${baseUrl}/events`);
    url.searchParams.set("limit", "250");
    url.searchParams.set("page", String(page));
    url.searchParams.set("filter[type]", "entity_responsible_changed");
    url.searchParams.set("filter[entity]", "lead");
    url.searchParams.set("filter[created_at][from]", String(from));
    url.searchParams.set("filter[created_at][to]", String(to));
    const res = await rateLimitedFetch(url.toString(), { headers });
    if (res.status === 204) break;
    if (!res.ok) throw new Error(`Kommo /events (responsible) page ${page}: HTTP ${res.status}`);
    const data = (await res.json()) as {
      _embedded?: { events?: RawEvent[] };
      _links?: { next?: unknown };
    };
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
    if (!data._links?.next || batch.length === 0) break;
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
  console.log(`[ETL] sync-responsible-changes: ${rows.length} rows`);
  return rows.length;
}
