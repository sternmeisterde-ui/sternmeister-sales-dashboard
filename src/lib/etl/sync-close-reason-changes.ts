/**
 * Тянет историю изменений Kommo CFV 879824 ("Причина закрытия госники")
 * за период [fromDate, toDate). Источник — `/api/v4/events?filter[type]=custom_field_879824_value_changed`.
 *
 * Идемпотентно: ON CONFLICT (event_id) DO NOTHING — повторный прогон не дублирует.
 *
 * Используется compute.ts для точного определения `disqualified_at` (как в
 * cohort-conversion's qualification.py). Без этих данных Funnel-цифры
 * расходятся с cohort-conversion из-за приближения через `lead.updated_at`.
 */

import { sql } from "drizzle-orm";
import { analyticsDb } from "@/lib/db/analytics";

// CFV 879824 = "Причина закрытия госники"
const CLOSE_REASON_CFV_ID = 879824;
const EVENT_TYPE = `custom_field_${CLOSE_REASON_CFV_ID}_value_changed`;

interface RawCfvEvent {
  id: number;
  type: string;
  entity_id: number;
  entity_type: string;
  created_by: number;
  created_at: number;
  value_before: Array<{
    custom_field_value?: {
      field_id?: number;
      enum_id?: number;
      value?: unknown;
    };
  }> | null;
  value_after: Array<{
    custom_field_value?: {
      field_id?: number;
      enum_id?: number;
      value?: unknown;
    };
  }> | null;
}

interface NormalizedEvent {
  event_id: string;
  lead_id: number;
  event_at: Date;
  enum_id_before: number | null;
  enum_id_after: number | null;
  created_by: number | null;
}

export async function syncCloseReasonChanges(
  fromDate: Date,
  toDate: Date
): Promise<number> {
  const { getBaseUrl, getAuthHeaders, rateLimitedFetch } = await import(
    "@/lib/kommo/client"
  );

  const baseUrl = await getBaseUrl();
  const headers = await getAuthHeaders();
  const fromTs = Math.floor(fromDate.getTime() / 1000);
  const toTs = Math.floor(toDate.getTime() / 1000);

  let page = 1;
  let totalUpserted = 0;
  const MAX_PAGES = 200; // safety limit, ~50к событий

  while (page <= MAX_PAGES) {
    const url = new URL(`${baseUrl}/events`);
    url.searchParams.set("filter[type]", EVENT_TYPE);
    url.searchParams.set("filter[created_at][from]", String(fromTs));
    url.searchParams.set("filter[created_at][to]", String(toTs));
    url.searchParams.set("filter[entity]", "lead");
    url.searchParams.set("limit", "250");
    url.searchParams.set("page", String(page));

    const res = await rateLimitedFetch(url.toString(), { headers });
    if (res.status === 204) break;
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(
        `[ETL] sync-close-reason-changes: HTTP ${res.status} on page ${page}: ${text}`,
      );
      break;
    }

    const data = (await res.json()) as {
      _embedded?: { events?: RawCfvEvent[] };
      _links?: { next?: unknown };
    };
    const events = data._embedded?.events ?? [];
    if (events.length === 0) break;

    const normalized = events
      .map(normalizeEvent)
      .filter((e): e is NormalizedEvent => e !== null);

    if (normalized.length > 0) {
      const count = await upsertEvents(normalized);
      totalUpserted += count;
    }

    if (!data._links?.next) break;
    page++;
  }

  console.log(
    `[ETL] sync-close-reason-changes: upserted ${totalUpserted} events for ${fromDate.toISOString().slice(0, 10)} → ${toDate.toISOString().slice(0, 10)} (${page} pages)`,
  );
  return totalUpserted;
}

function normalizeEvent(raw: RawCfvEvent): NormalizedEvent | null {
  if (raw.entity_type !== "lead" || !raw.entity_id) return null;
  // value_before/value_after — массивы объектов, каждый с custom_field_value.
  // У cohort-conversion: берём первый custom_field_value.enum_id.
  const before = firstCfv(raw.value_before);
  const after = firstCfv(raw.value_after);
  // Если ни до, ни после нет enum_id — нечего трекать.
  if (before === null && after === null) return null;
  return {
    event_id: String(raw.id),
    lead_id: raw.entity_id,
    event_at: new Date(raw.created_at * 1000),
    enum_id_before: before,
    enum_id_after: after,
    created_by: raw.created_by ?? null,
  };
}

function firstCfv(
  values: RawCfvEvent["value_before"] | RawCfvEvent["value_after"],
): number | null {
  if (!values) return null;
  for (const v of values) {
    const enumId = v?.custom_field_value?.enum_id;
    if (typeof enumId === "number" && Number.isFinite(enumId)) return enumId;
  }
  return null;
}

async function upsertEvents(events: NormalizedEvent[]): Promise<number> {
  // Чанками по 500, ON CONFLICT (event_id) DO NOTHING.
  const CHUNK = 500;
  let total = 0;
  for (let i = 0; i < events.length; i += CHUNK) {
    const slice = events.slice(i, i + CHUNK);
    const values = slice
      .map(
        (e) =>
          `('${escapeSqlText(e.event_id)}', ${e.lead_id}, '${e.event_at.toISOString()}'::timestamp, ${
            e.enum_id_before === null ? "NULL" : e.enum_id_before
          }, ${e.enum_id_after === null ? "NULL" : e.enum_id_after}, ${
            e.created_by === null ? "NULL" : e.created_by
          })`,
      )
      .join(", ");
    await analyticsDb.execute(sql`
      INSERT INTO analytics.lead_close_reason_changes
        (event_id, lead_id, event_at, enum_id_before, enum_id_after, created_by)
      VALUES ${sql.raw(values)}
      ON CONFLICT (event_id) DO NOTHING
    `);
    total += slice.length;
  }
  return total;
}

function escapeSqlText(s: string): string {
  return s.replace(/'/g, "''");
}
