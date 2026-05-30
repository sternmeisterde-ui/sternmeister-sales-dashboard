// ETL: sync contacts from Kommo API → analytics.contacts + lead_contact_links.
//
// Driven by the contact IDs that sync-leads collected from each lead's
// `_embedded.contacts`. Fetches full contact snapshots via getContactsByIds
// (batched 250/request, 1 rps via shared rateLimitedFetch), then upserts into
// analytics.contacts and analytics.lead_contact_links.
//
// Idempotent on both tables (ON CONFLICT DO UPDATE), so backfill can be
// stopped and restarted without dedup work. Old lead↔contact links are
// flipped to is_active=false when Kommo no longer returns them.

import { analyticsDb } from "@/lib/db/analytics";
import { contacts, leadContactLinks } from "@/lib/db/schema-analytics";
import { getContactsByIds, type KommoContactSnapshot } from "@/lib/kommo/client";
import { sql } from "drizzle-orm";
import type { LeadCacheEntry } from "./sync-leads";

/**
 * Extract phone numbers from a Kommo contact's custom_fields_values.
 * Kommo stores phones under field_code === "PHONE" with one or more values
 * (mobile/work/home). Returns the first as primary plus the full deduped list.
 */
export function extractPhones(
  customFields: KommoContactSnapshot["custom_fields_values"],
): { phone: string | null; phonesAll: string[] } {
  if (!customFields) return { phone: null, phonesAll: [] };

  const phoneField = customFields.find((f) => f?.field_code === "PHONE");
  if (!phoneField?.values) return { phone: null, phonesAll: [] };

  const all: string[] = [];
  const seen = new Set<string>();
  for (const v of phoneField.values) {
    if (typeof v?.value !== "string") continue;
    const trimmed = v.value.trim();
    if (!trimmed) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    all.push(trimmed);
  }

  return {
    phone: all[0] ?? null,
    phonesAll: all,
  };
}

function parseUnixTs(v: number | null | undefined): Date | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return new Date(v * 1000);
}

/**
 * Sync contacts referenced by the given lead cache entries. Called by
 * sync-leads after the leads themselves are written, so the FK-ish
 * relationship (lead_id in lead_contact_links) is guaranteed to resolve.
 *
 * Returns the number of contacts synced (not links — links may differ).
 */
export async function syncContacts(
  leadCache: LeadCacheEntry[],
): Promise<number> {
  // Build the set of contact IDs to fetch and the lead↔contact pairs to upsert.
  const contactIds = new Set<number>();
  const links: Array<{ leadId: number; contactId: number }> = [];
  for (const entry of leadCache) {
    for (const cid of entry.contactIds) {
      if (typeof cid !== "number" || !Number.isFinite(cid)) continue;
      contactIds.add(cid);
      links.push({ leadId: entry.leadId, contactId: cid });
    }
  }

  if (contactIds.size === 0) {
    console.log("[ETL] sync-contacts: no contact_ids found in lead batch");
    return 0;
  }

  // Fetch full contact snapshots (one Kommo request per 250 IDs, 1 rps).
  const snapshots = await getContactsByIds(Array.from(contactIds));
  if (snapshots.length === 0) {
    console.warn(
      `[ETL] sync-contacts: Kommo returned 0 contacts for ${contactIds.size} IDs`,
    );
    return 0;
  }

  // Build contact rows for upsert.
  const rows = snapshots.map((c) => {
    const { phone, phonesAll } = extractPhones(c.custom_fields_values);
    return {
      contactId: c.id,
      name: c.name,
      firstName: c.first_name,
      lastName: c.last_name,
      phone,
      phonesAll,
      responsibleUserId: c.responsible_user_id,
      kommoCreatedAt: parseUnixTs(c.created_at),
      kommoUpdatedAt: parseUnixTs(c.updated_at),
      rawPayload: c as unknown as Record<string, unknown>,
    };
  });

  // Upsert in chunks (Postgres parameter limit is 65535; ~10 params per row
  // means safe chunk is well below 6000).
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    await analyticsDb
      .insert(contacts)
      .values(slice)
      .onConflictDoUpdate({
        target: contacts.contactId,
        set: {
          name: sql`EXCLUDED.name`,
          firstName: sql`EXCLUDED.first_name`,
          lastName: sql`EXCLUDED.last_name`,
          phone: sql`EXCLUDED.phone`,
          phonesAll: sql`EXCLUDED.phones_all`,
          responsibleUserId: sql`EXCLUDED.responsible_user_id`,
          kommoCreatedAt: sql`EXCLUDED.kommo_created_at`,
          kommoUpdatedAt: sql`EXCLUDED.kommo_updated_at`,
          rawPayload: sql`EXCLUDED.raw_payload`,
          syncedAt: sql`NOW()`,
        },
      });
  }

  // Upsert lead↔contact links. Update last_seen_at + re-activate on each
  // observation; rows are never deleted.
  if (links.length > 0) {
    const LINK_CHUNK = 1000;
    for (let i = 0; i < links.length; i += LINK_CHUNK) {
      const slice = links.slice(i, i + LINK_CHUNK);
      await analyticsDb
        .insert(leadContactLinks)
        .values(slice.map((l) => ({ leadId: l.leadId, contactId: l.contactId })))
        .onConflictDoUpdate({
          target: [leadContactLinks.leadId, leadContactLinks.contactId],
          set: {
            lastSeenAt: sql`NOW()`,
            isActive: sql`TRUE`,
          },
        });
    }
  }

  // Deactivate stale links: for each lead in this batch, mark any link not in
  // the current set as is_active=false. Done lead-by-lead to keep the IN
  // clause manageable; this is small per sync cycle (incremental syncs touch
  // hundreds of leads, not thousands).
  const linksByLead = new Map<number, Set<number>>();
  for (const l of links) {
    if (!linksByLead.has(l.leadId)) linksByLead.set(l.leadId, new Set());
    linksByLead.get(l.leadId)!.add(l.contactId);
  }

  for (const [leadId, activeContactIds] of linksByLead) {
    if (activeContactIds.size === 0) continue;
    const idsSql = sql.join(
      Array.from(activeContactIds).map((id) => sql`${id}`),
      sql`, `,
    );
    await analyticsDb.execute(sql`
      UPDATE analytics.lead_contact_links
      SET is_active = FALSE, last_seen_at = NOW()
      WHERE lead_id = ${leadId}
        AND contact_id NOT IN (${idsSql})
        AND is_active = TRUE
    `);
  }

  console.log(
    `[ETL] sync-contacts: upserted ${rows.length} contacts, ${links.length} links`,
  );
  return rows.length;
}
