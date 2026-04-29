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
import { db } from "@/lib/db";
import { masterManagers, managerSchedule } from "@/lib/db/schema-existing";
import { leadsCohort, sla, communications } from "@/lib/db/schema-analytics";
import { and, gte, lte, sql, eq, inArray } from "drizzle-orm";
import { businessHoursSeconds, secondsFromShiftStart, calendarSeconds } from "./business-hours";

// Parse "HH:MM" → hour as number (0–23). Returns null on unparsable.
function parseHour(s: string | null | undefined): number | null {
  if (!s) return null;
  const h = Number(s.split(":")[0]);
  return Number.isFinite(h) ? h : null;
}

export async function computeSla(
  fromDate: Date,
  toDate: Date,
  /** If provided, recompute SLA only for these specific lead IDs (incremental mode). */
  filterLeadIds?: number[],
): Promise<number> {
  // Find leads: either by specific IDs (incremental) or by creation date range (full)
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
      filterLeadIds && filterLeadIds.length > 0
        ? inArray(leadsCohort.leadId, filterLeadIds)
        : and(
            gte(leadsCohort.createdAt, fromDate),
            lte(leadsCohort.createdAt, toDate),
          ),
    );

  if (leads.length === 0) return 0;

  // Load shift-start hours with two layers of precedence:
  //   1. manager_schedule.shift_start_time for the exact call date (historical snapshot)
  //   2. master_managers.shift_start_time (current default)
  //   3. fallback → 09:00
  const managerRows = await db.select({
    id: masterManagers.id,
    name: masterManagers.name,
    shiftStartTime: masterManagers.shiftStartTime,
  }).from(masterManagers);

  const defaultShiftHourByManager = new Map<string, number>();
  const managerIdByName = new Map<string, string>();
  for (const m of managerRows) {
    managerIdByName.set(m.name, m.id);
    const h = parseHour(m.shiftStartTime);
    if (h !== null) defaultShiftHourByManager.set(m.name, h);
  }

  const scheduleRows = await db.select({
    userId: managerSchedule.userId,
    scheduleDate: managerSchedule.scheduleDate,
    shiftStartTime: managerSchedule.shiftStartTime,
  }).from(managerSchedule);

  // Key: `${managerId}|${YYYY-MM-DD}` → hour
  const scheduleShiftHour = new Map<string, number>();
  for (const r of scheduleRows) {
    const h = parseHour(r.shiftStartTime);
    if (h !== null) scheduleShiftHour.set(`${r.userId}|${r.scheduleDate}`, h);
  }

  // Neon HTTP returns `timestamp` (no-tz) columns as bare strings ("2026-04-22 18:17:15").
  // new Date() parses those as LOCAL time on the server. Force UTC by appending Z.
  for (const lead of leads) {
    if (lead.createdAt && typeof (lead.createdAt as unknown) === "string") {
      lead.createdAt = new Date(`${String(lead.createdAt).replace(" ", "T")}Z`);
    }
  }

  const leadIds = leads.map((l) => l.leadId).filter((id): id is number => id !== null);

  // sla_start = first event_at in the lead's most-meaningful "main"
  // pipeline. Replicates the integrator's logic verified empirically
  // against 9 sample leads:
  //   * Lead currently in Бух Бератер  → first Бух Бератер entry
  //   * Lead currently in Бух Гос       → first Бух Гос entry
  //   * Lead currently in Бух Комм but
  //     historically passed through
  //     Бух Гос                          → first Бух Гос entry
  //   * Lead never touched Бух Гос      → first event in next pipeline by
  //                                        priority: Бух Бератер → Бух Комм
  //                                        → Мед Гос → Мед Комм
  //   * No status events at all          → fallback to lead_created_at
  //
  // Pipelines OUTSIDE this priority list (Аппеляции, webinars, Тестовая,
  // Обучение) are intentionally skipped — they're not part of the SLA
  // funnel and a lead's brief detour through them shouldn't move
  // sla_start. COALESCE walks the priority list and picks the first
  // pipeline that has any history.
  const slaStartRes = await analyticsDb.execute<{
    lead_id: number;
    sla_start_at: Date | null;
  }>(sql`
    SELECT lead_id,
           COALESCE(
             MIN(event_at) FILTER (WHERE pipeline = 'Бух Гос'),
             MIN(event_at) FILTER (WHERE pipeline = 'Бух Бератер'),
             MIN(event_at) FILTER (WHERE pipeline = 'Бух Комм'),
             MIN(event_at) FILTER (WHERE pipeline = 'Мед Гос'),
             MIN(event_at) FILTER (WHERE pipeline = 'Мед Комм')
           ) AT TIME ZONE 'UTC' AS sla_start_at
    FROM analytics.lead_status_changes
    WHERE lead_id IN (${sql.raw(leadIds.join(","))})
    GROUP BY lead_id
  `);
  const slaStartByLead = new Map<number, Date>();
  for (const row of slaStartRes.rows) {
    if (row.sla_start_at) {
      slaStartByLead.set(Number(row.lead_id), new Date(row.sla_start_at));
    }
  }

  // Fetch communication summaries for these leads.
  //
  // AT TIME ZONE 'UTC' converts bare `timestamp` columns to `timestamptz` so
  // the Neon HTTP client returns ISO strings with Z suffix. Without this,
  // Node.js parses the bare string in the server's local timezone.
  //
  // Бератер post-transfer floor: telephony phone-enrichment can match calls
  // that happened while the lead was still in Бух Гос (before transfer to
  // Бух Бератер). Those pre-transfer calls would corrupt MIN(created_at).
  // We floor first_call_out_at by the latest event_at of the lead's entry
  // into Бух Бератер in `lead_status_changes`. For non-Бератер leads the
  // floor is NULL → no effect.
  const commSummaries = await analyticsDb.execute<{
    lead_id: number;
    first_contact_at: Date | null;
    first_call_out_at: Date | null;
    first_message_at: Date | null;
    last_contact_at: Date | null;
  }>(sql`
    WITH berater_floor AS (
      SELECT lead_id, MIN(event_at) AS entry_at
      FROM analytics.lead_status_changes
      WHERE lead_id IN (${sql.raw(leadIds.join(","))})
        AND pipeline = 'Бух Бератер'
      GROUP BY lead_id
    )
    SELECT
      c.lead_id,
      (MIN(c.created_at))                                                  AT TIME ZONE 'UTC' AS first_contact_at,
      (MIN(c.created_at) FILTER (
         WHERE c.communication_type = 'call_out'
           AND (bf.entry_at IS NULL OR c.created_at >= bf.entry_at)
      ))                                                                   AT TIME ZONE 'UTC' AS first_call_out_at,
      (MIN(c.created_at) FILTER (WHERE c.communication_type = 'outgoing_chat_message'))
                                                                           AT TIME ZONE 'UTC' AS first_message_at,
      (MAX(c.created_at))                                                  AT TIME ZONE 'UTC' AS last_contact_at
    FROM analytics.communications c
    LEFT JOIN berater_floor bf ON bf.lead_id = c.lead_id
    WHERE c.lead_id IN (${sql.raw(leadIds.join(","))})
    GROUP BY c.lead_id
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

    // sla_start: prefer the first entry into the lead's CURRENT pipeline
    // (matches integrator's behaviour for transferred / reactivated leads).
    // Fallback to lead_created_at for leads with no status history yet.
    const slaStart = slaStartByLead.get(lead.leadId) ?? lead.createdAt;

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
    // SLA from shift start: per-day shift from manager_schedule if present, else master_managers default, else 09:00.
    let managerShiftHour = 9;
    if (lead.manager) {
      const managerId = managerIdByName.get(lead.manager);
      if (comms.firstCallOutAt && managerId) {
        const callDate = comms.firstCallOutAt.toISOString().slice(0, 10); // UTC date; business-hours in Berlin may shift <= 1h but acceptable
        const perDay = scheduleShiftHour.get(`${managerId}|${callDate}`);
        if (perDay !== undefined) managerShiftHour = perDay;
        else managerShiftHour = defaultShiftHourByManager.get(lead.manager) ?? 9;
      } else {
        managerShiftHour = defaultShiftHourByManager.get(lead.manager) ?? 9;
      }
    }
    const slaFirstCallFromShiftSec = comms.firstCallOutAt
      ? secondsFromShiftStart(comms.firstCallOutAt, managerShiftHour)
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
      slaFirstCallFromShiftSeconds: slaFirstCallFromShiftSec,
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
