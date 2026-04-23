// Compute analytics.sla from datasource tables (leads_cohort + communications)
// Run AFTER syncLeads and syncCommunications are complete for the target date range.
//
// SLA fields:
//   sla_start           = lead_created_at (integrator adds ~3min webhook lag; we skip that)
//   first_contact_at    = MIN(created_at) from communications (any type)
//   first_call_out_at   = MIN(created_at) WHERE communication_type='call_out'
//   first_message_at    = MIN(created_at) WHERE communication_type='outgoing_chat_message'
//   last_contact_at     = MAX(created_at) from communications (any type)
//   sla_first_call_seconds         = business_hours(sla_start, first_call_out_at)
//   sla_first_call_calendar_seconds= EXTRACT(EPOCH, first_call_out_at - sla_start)
//   sla_first_contact_seconds      = business_hours(sla_start, first_contact_at)
//   business_hours_since_last_contact = business_hours(sla_start, last_contact_at)
//   sla_status = 'contacted'|'frozen'|'waiting'

import { analyticsDb } from "@/lib/db/analytics";
import { leadsCohort, sla, communications } from "@/lib/db/schema-analytics";
import { and, gte, lte, sql, eq, inArray } from "drizzle-orm";
import { businessHoursSeconds, calendarSeconds } from "./business-hours";

export async function computeSla(
  fromDate: Date,
  toDate: Date,
): Promise<number> {
  // Find all leads created in this date range
  const leads = await analyticsDb
    .select({
      leadId: leadsCohort.leadId,
      createdAt: leadsCohort.createdAt,
      pipelineId: leadsCohort.pipelineId,
      pipelineName: leadsCohort.pipeline,
      statusId: leadsCohort.statusId,
      statusName: leadsCohort.status,
      utmSource: leadsCohort.utmSource,
      category: leadsCohort.category,
      manager: leadsCohort.manager,
      lossReason: leadsCohort.lossReason,
    })
    .from(leadsCohort)
    .where(
      and(
        gte(leadsCohort.createdAt, fromDate),
        lte(leadsCohort.createdAt, toDate),
      ),
    );

  if (leads.length === 0) return 0;

  // Neon HTTP returns `timestamp` (no-tz) columns as bare strings ("2026-04-22 18:17:15").
  // new Date() parses those as LOCAL time on the server. Force UTC by appending Z.
  for (const lead of leads) {
    if (lead.createdAt && typeof (lead.createdAt as unknown) === "string") {
      lead.createdAt = new Date(`${String(lead.createdAt).replace(" ", "T")}Z`);
    }
  }

  const leadIds = leads.map((l) => l.leadId).filter((id): id is number => id !== null);

  // Fetch communication summaries for these leads
  // AT TIME ZONE 'UTC' converts bare `timestamp` columns to `timestamptz` so that
  // the Neon HTTP client returns ISO strings with Z suffix. Without this, Node.js
  // parses the bare string in the server's local timezone (e.g. Europe/Berlin → 2h off).
  const commSummaries = await analyticsDb.execute<{
    lead_id: number;
    first_contact_at: Date | null;
    first_call_out_at: Date | null;
    first_message_at: Date | null;
    last_contact_at: Date | null;
  }>(sql`
    SELECT
      lead_id,
      (MIN(created_at))                                               AT TIME ZONE 'UTC' AS first_contact_at,
      (MIN(created_at) FILTER (WHERE communication_type = 'call_out')) AT TIME ZONE 'UTC' AS first_call_out_at,
      (MIN(created_at) FILTER (WHERE communication_type = 'outgoing_chat_message')) AT TIME ZONE 'UTC' AS first_message_at,
      (MAX(created_at))                                               AT TIME ZONE 'UTC' AS last_contact_at
    FROM analytics.communications
    WHERE lead_id IN (${sql.raw(leadIds.join(","))})
    GROUP BY lead_id
  `);

  const commMap = new Map<
    number,
    {
      firstContactAt: Date | null;
      firstCallOutAt: Date | null;
      firstMessageAt: Date | null;
      lastContactAt: Date | null;
    }
  >();
  for (const row of commSummaries.rows) {
    commMap.set(Number(row.lead_id), {
      firstContactAt: row.first_contact_at ? new Date(row.first_contact_at) : null,
      firstCallOutAt: row.first_call_out_at ? new Date(row.first_call_out_at) : null,
      firstMessageAt: row.first_message_at ? new Date(row.first_message_at) : null,
      lastContactAt: row.last_contact_at ? new Date(row.last_contact_at) : null,
    });
  }

  type SlaRow = typeof sla.$inferInsert;
  const rows: SlaRow[] = [];

  for (const lead of leads) {
    if (!lead.leadId || !lead.createdAt) continue;

    const comms = commMap.get(lead.leadId) ?? {
      firstContactAt: null,
      firstCallOutAt: null,
      firstMessageAt: null,
      lastContactAt: null,
    };

    const slaStart = lead.createdAt; // integrator adds ~3min; we use created_at directly

    const isWaiting = comms.firstContactAt === null ? 1 : 0;
    const isWaitingCall = comms.firstCallOutAt === null ? 1 : 0;

    const slaFirstContactSec = comms.firstContactAt
      ? businessHoursSeconds(slaStart, comms.firstContactAt)
      : null;
    const slaFirstCallSec = comms.firstCallOutAt
      ? businessHoursSeconds(slaStart, comms.firstCallOutAt)
      : null;
    const slaFirstCallCalSec = comms.firstCallOutAt
      ? calendarSeconds(slaStart, comms.firstCallOutAt)
      : null;
    const bhSinceLastContact = comms.lastContactAt
      ? businessHoursSeconds(slaStart, comms.lastContactAt)
      : null;

    let slaStatus: string;
    if (isWaiting) {
      slaStatus = "waiting";
    } else {
      // 'frozen' heuristic: lead has been contacted but is marked as paused/deferred
      // Without Kommo tag data we approximate: waiting_call + has_message = frozen
      slaStatus = isWaitingCall && comms.firstMessageAt ? "frozen" : "contacted";
    }

    rows.push({
      leadId: lead.leadId,
      leadCreatedAt: lead.createdAt,
      pipelineId: lead.pipelineId ?? null,
      pipelineName: lead.pipelineName ?? null,
      statusId: lead.statusId ?? null,
      statusName: lead.statusName ?? null,
      utmSource: lead.utmSource ?? null,
      category: lead.category ?? null,
      manager: lead.manager ?? null,
      lossReasonName: lead.lossReason ?? null,
      slaStart,
      firstContactAt: comms.firstContactAt,
      lastContactAt: comms.lastContactAt,
      firstCallOutAt: comms.firstCallOutAt,
      firstMessageAt: comms.firstMessageAt,
      isWaiting,
      isWaitingCall,
      slaFirstContactSeconds: slaFirstContactSec,
      slaFirstCallSeconds: slaFirstCallSec,
      slaFirstCallCalendarSeconds: slaFirstCallCalSec,
      businessHoursSinceLastContact: bhSinceLastContact,
      slaStatus,
    });
  }

  // Delete existing SLA rows for these leads, then insert
  await analyticsDb.execute(
    sql.raw(`DELETE FROM analytics.sla WHERE lead_id IN (${leadIds.join(",")})`),
  );

  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    await analyticsDb.insert(sla).values(rows.slice(i, i + CHUNK));
  }

  console.log(`[ETL] compute-sla: computed ${rows.length} SLA rows`);
  return rows.length;
}
