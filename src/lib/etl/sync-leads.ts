// ETL: sync leads from Kommo API → analytics.leads_cohort
// Fetches leads for a creation date range, upserts via DELETE+INSERT.

import { getLeads } from "@/lib/kommo/client";
import { analyticsDb } from "@/lib/db/analytics";
import { leadsCohort } from "@/lib/db/schema-analytics";
import { sql } from "drizzle-orm";
import type { KommoLookups } from "./lookups";

// Custom field IDs in Kommo for this account
const CF = {
  UTM_SOURCE: 849510,
  UTM_MEDIUM: 849506,
  UTM_CAMPAIGN: 849508,
  UTM_CONTENT: 849504,
  UTM_TERM: 849512,
  CATEGORY: 866934,
} as const;

export interface LeadCacheEntry {
  leadId: number;
  createdAt: Date;
  pipelineId: number;
  pipelineName: string;
  statusId: number;
  statusName: string;
  statusOrder: number;
  category: string | null;
  manager: string | null;
  responsibleUserId: number;
  contactIds: number[];
}

function cfVal(
  fields: Array<{ field_id: number; values: Array<{ value: unknown }> }> | null,
  id: number,
): string | null {
  const f = fields?.find((x) => x.field_id === id);
  const v = f?.values?.[0]?.value;
  return typeof v === "string" && v ? v : null;
}

export async function syncLeads(
  fromDate: Date,
  toDate: Date,
  lookups: KommoLookups,
): Promise<LeadCacheEntry[]> {
  const fromTs = Math.floor(fromDate.getTime() / 1000);
  const toTs = Math.floor(toDate.getTime() / 1000);

  const raw = await getLeads(
    undefined,
    undefined,
    500,
    { field: "created_at", from: fromTs, to: toTs },
    true, // withContacts — needed for call events contact→lead resolution
  );

  if (raw.length === 0) {
    console.log("[ETL] sync-leads: 0 leads in range");
    return [];
  }

  const rows: typeof leadsCohort.$inferInsert[] = [];
  const cache: LeadCacheEntry[] = [];

  for (const lead of raw) {
    const pipeline = lookups.pipelines.get(lead.pipeline_id);
    const status = pipeline?.statuses.get(lead.status_id);
    const createdAt = new Date(lead.created_at * 1000);

    const entry: LeadCacheEntry = {
      leadId: lead.id,
      createdAt,
      pipelineId: lead.pipeline_id,
      pipelineName: pipeline?.name ?? String(lead.pipeline_id),
      statusId: lead.status_id,
      statusName: status?.name ?? String(lead.status_id),
      statusOrder: status?.sort ?? 0,
      category: cfVal(lead.custom_fields_values, CF.CATEGORY),
      manager: lookups.users.get(lead.responsible_user_id) ?? null,
      responsibleUserId: lead.responsible_user_id,
      contactIds: lead._embedded?.contacts?.map((c) => c.id) ?? [],
    };
    cache.push(entry);

    rows.push({
      leadId: lead.id,
      createdAt,
      utmSource: cfVal(lead.custom_fields_values, CF.UTM_SOURCE),
      utmMedium: cfVal(lead.custom_fields_values, CF.UTM_MEDIUM),
      utmCampaign: cfVal(lead.custom_fields_values, CF.UTM_CAMPAIGN),
      utmContent: cfVal(lead.custom_fields_values, CF.UTM_CONTENT),
      utmTerm: cfVal(lead.custom_fields_values, CF.UTM_TERM),
      lossReason: lead.loss_reason_id
        ? (lookups.lossReasons.get(lead.loss_reason_id) ?? null)
        : null,
      lossReasonId: lead.loss_reason_id ?? null,
      pipeline: entry.pipelineName,
      pipelineId: lead.pipeline_id,
      status: entry.statusName,
      statusId: lead.status_id,
      statusOrder: entry.statusOrder,
      budget: lead.price,
      contactDate: null, // computed after communications are synced
      manager: entry.manager,
      responsibleUserId: lead.responsible_user_id,
      category: entry.category,
    });
  }

  // Upsert: delete rows for these lead IDs, then insert fresh
  const leadIds = rows.map((r) => r.leadId).filter(Boolean) as number[];

  await analyticsDb.execute(
    sql.raw(`DELETE FROM analytics.leads_cohort WHERE lead_id IN (${leadIds.join(",")})`),
  );

  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    await analyticsDb.insert(leadsCohort).values(rows.slice(i, i + CHUNK));
  }

  console.log(`[ETL] sync-leads: inserted ${rows.length} leads`);
  return cache;
}

/** Update contact_date in leads_cohort from the communications table */
export async function updateContactDates(leadIds: number[]): Promise<void> {
  if (leadIds.length === 0) return;
  await analyticsDb.execute(sql`
    UPDATE analytics.leads_cohort lc
    SET contact_date = sub.first_contact
    FROM (
      SELECT lead_id, MIN(created_at) AS first_contact
      FROM analytics.communications
      WHERE lead_id IN (${sql.raw(leadIds.join(","))})
      GROUP BY lead_id
    ) sub
    WHERE lc.lead_id = sub.lead_id
  `);
}
