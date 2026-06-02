/**
 * Тянет события lead_deleted из Kommo /api/v4/events и помечает лиды как удалённые
 * в analytics.leads_cohort (is_deleted=TRUE + deleted_at).
 *
 * Funnel Dashboard исключает удалённые лиды из base — без этого расхождение
 * с cohort-conversion (где deleted leads тоже фильтруются).
 */

import { sql } from "drizzle-orm";
import { analyticsDb } from "@/lib/db/analytics";

interface RawDeletedEvent {
  id: number;
  type: string;
  entity_id: number;
  entity_type: string;
  created_at: number;
}

export async function syncLeadDeletions(
  fromDate: Date,
  toDate: Date,
): Promise<number> {
  const { getBaseUrl, getAuthHeaders, rateLimitedFetch } = await import(
    "@/lib/kommo/client"
  );
  const baseUrl = await getBaseUrl();
  const headers = await getAuthHeaders();
  const fromTs = Math.floor(fromDate.getTime() / 1000);
  const toTs = Math.floor(toDate.getTime() / 1000);

  let page = 1;
  let totalMarked = 0;
  const MAX_PAGES = 200;

  while (page <= MAX_PAGES) {
    const url = new URL(`${baseUrl}/events`);
    url.searchParams.set("filter[type]", "lead_deleted");
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
        `[ETL] sync-lead-deletions: HTTP ${res.status} on page ${page}: ${text}`,
      );
      break;
    }

    const data = (await res.json()) as {
      _embedded?: { events?: RawDeletedEvent[] };
      _links?: { next?: unknown };
    };
    const events = data._embedded?.events ?? [];
    if (events.length === 0) break;

    // Группируем (leadId, deletedAt) — берём earliest event_at per lead
    const byLead = new Map<number, Date>();
    for (const ev of events) {
      if (ev.entity_type !== "lead" || !ev.entity_id) continue;
      const at = new Date(ev.created_at * 1000);
      const existing = byLead.get(ev.entity_id);
      if (!existing || at < existing) byLead.set(ev.entity_id, at);
    }

    if (byLead.size > 0) {
      const marked = await markDeleted(byLead);
      totalMarked += marked;
    }

    if (!data._links?.next) break;
    page++;
  }

  console.log(
    `[ETL] sync-lead-deletions: marked ${totalMarked} leads as deleted for ${fromDate.toISOString().slice(0, 10)} → ${toDate.toISOString().slice(0, 10)} (${page} pages)`,
  );
  return totalMarked;
}

async function markDeleted(byLead: Map<number, Date>): Promise<number> {
  // Чанками по 1000 lead_id. Для каждого: UPDATE ... WHERE lead_id IN (...).
  // Используем COALESCE чтобы не перезаписывать раньше зафиксированный deleted_at.
  const entries = Array.from(byLead.entries());
  const CHUNK = 1000;
  let total = 0;
  for (let i = 0; i < entries.length; i += CHUNK) {
    const slice = entries.slice(i, i + CHUNK);
    // Строим VALUES (...) с inлайнингом — lead_id это число, deleted_at это
    // ISO timestamp.
    const values = slice
      .map(([leadId, at]) => `(${leadId}, '${at.toISOString()}'::timestamp)`)
      .join(", ");
    const r = await analyticsDb.execute(sql`
      UPDATE analytics.leads_cohort lc
      SET
        is_deleted = TRUE,
        deleted_at = COALESCE(lc.deleted_at, sub.deleted_at)
      FROM (VALUES ${sql.raw(values)}) AS sub(lead_id, deleted_at)
      WHERE lc.lead_id = sub.lead_id
    `);
    // PostgreSQL returns affected rowCount in result.rowCount or similar.
    // For analyticsDb (drizzle-neon), it's not directly available — count by entries.
    total += slice.length;
  }
  return total;
}
