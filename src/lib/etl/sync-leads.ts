// ETL: sync leads from Kommo API → analytics.leads_cohort
// Fetches leads for a creation date range, upserts via DELETE+INSERT.

import { getLeads } from "@/lib/kommo/client";
import { analyticsDb } from "@/lib/db/analytics";
import { leadsCohort } from "@/lib/db/schema-analytics";
import { sql } from "drizzle-orm";
import type { KommoLookups } from "./lookups";
import {
  B2B_CUSTOM_FIELD_NAMES,
  B2G_CUSTOM_FIELD_IDS,
} from "@/lib/kommo/pipeline-config";

// Custom field IDs in Kommo for this account
const CF = {
  UTM_SOURCE: 849510,
  UTM_MEDIUM: 849506,
  UTM_CAMPAIGN: 849508,
  UTM_CONTENT: 849504,
  UTM_TERM: 849512,
  CATEGORY: 866934,
  /**
   * Language level (text): "A2 (Базовый уровень) — Свободно..." etc.
   * Used by Funnel Dashboard for language-level cohort breakdown.
   */
  LANGUAGE_LEVEL: 869928,
  /**
   * Exclude-from-analytics flag (checkbox/select): when set, lead is
   * dropped from Funnel computations (qualified base, target). See
   * cohort-conversion analytics_exclusion.py.
   */
  EXCLUDE_FROM_ANALYTICS: 887458,
  /**
   * Non-qual reason (enum): 744486 Неправильный номер, 744876/747530/747532/
   * 747534/747536 → Неквал (доход / образование / возраст / язык / прочее).
   * Referenced in build-response.ts B2G qualLeads filter.
   */
  NON_QUAL_REASON: 879824,
  /**
   * B2B closing reason (enum, "Причины закрытия (Обязательное поле)").
   * Required by Kommo at status_id=143 on pipelines 10631243/13209983.
   * Used by Looker B2B SLA gate to drop {Неквал лид, Спам, Предложение
   * сотрудничества} from the SLA AVG.
   */
  B2B_CLOSE_REASON: 876383,
} as const;

// ---- B2B payment custom-fields (looked up by name, not by id) ----
// Field IDs for payment dates/amounts vary per Kommo account, so we match
// by field_name exactly as used in build-response.ts:findCustomField.
type CustomFields = Array<{
  field_id: number;
  field_name: string;
  values: Array<{ value: unknown }>;
}> | null;

function parseDate(v: unknown): Date | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number" && Number.isFinite(v)) {
    const ms = v > 10_000_000_000 ? v : v * 1000;
    return new Date(ms);
  }
  if (typeof v === "string") {
    const trimmed = v.trim();
    if (trimmed === "") return null;
    if (/^\d+$/.test(trimmed)) return parseDate(Number(trimmed));
    const ms = Date.parse(trimmed);
    if (!Number.isNaN(ms)) return new Date(ms);
    // Non-parseable string — log once so unknown formats surface in ETL output.
    // V8 Date.parse rejects `DD.MM.YYYY` silently; without this log we'd write
    // NULL and quietly lose a payment date.
    console.warn(`[ETL:parseDate] unrecognised date string ignored: ${JSON.stringify(trimmed.slice(0, 40))}`);
  }
  return null;
}

function parseNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v.replace(/\s/g, "").replace(",", "."));
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function findByName(fields: CustomFields, names: readonly string[]): unknown | undefined {
  if (!fields) return undefined;
  const normalized = new Set(names.map((n) => n.toLowerCase().trim()));
  for (const f of fields) {
    if (f?.field_name && normalized.has(f.field_name.toLowerCase().trim())) {
      return f.values?.[0]?.value;
    }
  }
  return undefined;
}

/** Locate a custom field by its EXACT Kommo field_id and return its first
 *  value. Preferred over findByName when the field's intent is unique (e.g.
 *  "Дата термина ДЦ" 887026 vs "Дата термина" 885996 — distinct purposes,
 *  must not be conflated). */
function findByFieldId(fields: CustomFields, fieldId: number): unknown | undefined {
  return fields?.find((f) => f?.field_id === fieldId)?.values?.[0]?.value;
}

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

/** Extract enum_id for a custom field (used for non-qual reason field 879824). */
function cfEnumId(
  fields: Array<{ field_id: number; values: Array<{ enum_id?: number }> }> | null,
  id: number,
): number | null {
  const f = fields?.find((x) => x.field_id === id);
  const enumId = f?.values?.[0]?.enum_id;
  return typeof enumId === "number" && Number.isFinite(enumId) ? enumId : null;
}

/**
 * Boolean CFV (checkbox or "yes"/"true" select). Returns true if value is
 * truthy according to Kommo conventions:
 *   - boolean true
 *   - string "1", "yes", "true", "да", "y"
 *   - number 1
 * NULL/missing/0/etc → false.
 */
function cfBoolean(
  fields: Array<{ field_id: number; values: Array<{ value: unknown }> }> | null,
  id: number,
): boolean {
  const f = fields?.find((x) => x.field_id === id);
  const v = f?.values?.[0]?.value;
  if (v === true) return true;
  if (typeof v === "number") return v === 1;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    return s === "1" || s === "yes" || s === "true" || s === "y" || s === "да";
  }
  return false;
}

export async function syncLeads(
  fromDate: Date,
  toDate: Date,
  lookups: KommoLookups,
  dateField: "created_at" | "updated_at" = "created_at",
): Promise<LeadCacheEntry[]> {
  const fromTs = Math.floor(fromDate.getTime() / 1000);
  const toTs = Math.floor(toDate.getTime() / 1000);

  const raw = await getLeads(
    undefined,
    undefined,
    500,
    { field: dateField, from: fromTs, to: toTs },
    true, // withContacts — needed for call events contact→lead resolution
  );

  if (raw.length === 0) {
    console.log("[ETL] sync-leads: 0 leads in range");
    return [];
  }

  const rows: typeof leadsCohort.$inferInsert[] = [];
  const cache: LeadCacheEntry[] = [];

  // B1: pre-fetch existing termin_date_first / aa_termin_date_first so the
  // upcoming DELETE+INSERT doesn't drop the original commitment dates. Once
  // a first-observed value is in DB it never changes — we only seed it for
  // leads that don't have one yet.
  const incomingLeadIds = raw
    .map((l) => l.id)
    .filter((id): id is number => typeof id === "number" && Number.isFinite(id));
  const existingFirstDates = new Map<
    number,
    { terminDateFirst: Date | null; aaTerminDateFirst: Date | null }
  >();
  if (incomingLeadIds.length > 0) {
    const FETCH_CHUNK = 5000;
    for (let i = 0; i < incomingLeadIds.length; i += FETCH_CHUNK) {
      const slice = incomingLeadIds.slice(i, i + FETCH_CHUNK);
      const existing = await analyticsDb.execute<{
        lead_id: number | string;
        termin_date_first: string | Date | null;
        aa_termin_date_first: string | Date | null;
      }>(sql`
        SELECT lead_id, termin_date_first, aa_termin_date_first
        FROM analytics.leads_cohort
        WHERE lead_id IN (${sql.join(slice.map((id) => sql`${id}`), sql`, `)})
          AND (termin_date_first IS NOT NULL OR aa_termin_date_first IS NOT NULL)
      `);
      for (const r of existing.rows) {
        existingFirstDates.set(Number(r.lead_id), {
          terminDateFirst:
            r.termin_date_first == null
              ? null
              : r.termin_date_first instanceof Date
                ? r.termin_date_first
                : new Date(r.termin_date_first),
          aaTerminDateFirst:
            r.aa_termin_date_first == null
              ? null
              : r.aa_termin_date_first instanceof Date
                ? r.aa_termin_date_first
                : new Date(r.aa_termin_date_first),
        });
      }
    }
  }

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

    const cf = lead.custom_fields_values;
    const closedAt = lead.closed_at ? new Date(lead.closed_at * 1000) : null;
    const firstPaymentDate = parseDate(findByName(cf, B2B_CUSTOM_FIELD_NAMES.firstPaymentDate));
    const firstPaymentAmount = parseNumber(findByName(cf, B2B_CUSTOM_FIELD_NAMES.firstPaymentAmount));
    const prepaymentDate = parseDate(findByName(cf, B2B_CUSTOM_FIELD_NAMES.prepaymentDate));
    const prepaymentAmount = parseNumber(findByName(cf, B2B_CUSTOM_FIELD_NAMES.prepaymentAmount));
    const nonQualEnumId = cfEnumId(
      lead.custom_fields_values as Array<{ field_id: number; values: Array<{ enum_id?: number }> }> | null,
      CF.NON_QUAL_REASON,
    );
    const b2bCloseReasonEnumId = cfEnumId(
      lead.custom_fields_values as Array<{ field_id: number; values: Array<{ enum_id?: number }> }> | null,
      CF.B2B_CLOSE_REASON,
    );
    // Termin dashboard fields — Бух Бератер pipeline (12154099). Read by
    // explicit field_id so the priority is unambiguous: prefer the specific
    // "Дата термина ДЦ" (887026), fall back to the legacy generic
    // "Дата термина" (885996) ONLY when the specific one is unset (older
    // leads predating the DC/AA split). AA has no legacy counterpart.
    const terminDate =
      parseDate(findByFieldId(cf, B2G_CUSTOM_FIELD_IDS.terminDateDC)) ??
      parseDate(findByFieldId(cf, B2G_CUSTOM_FIELD_IDS.terminDateGeneric));
    const aaTerminDate = parseDate(
      findByFieldId(cf, B2G_CUSTOM_FIELD_IDS.terminDateAA),
    );

    // B1: write-once. Keep the existing first-date if any; otherwise seed
    // with the current value (this becomes the FIRST observed date for new
    // leads or for leads that just had their first termin set).
    const existing = existingFirstDates.get(lead.id);
    const terminDateFirst = existing?.terminDateFirst ?? terminDate;
    const aaTerminDateFirst = existing?.aaTerminDateFirst ?? aaTerminDate;

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
      closedAt,
      firstPaymentDate,
      firstPaymentAmount,
      prepaymentDate,
      prepaymentAmount,
      nonQualEnumId,
      b2bCloseReasonEnumId,
      terminDate,
      aaTerminDate,
      terminDateFirst,
      aaTerminDateFirst,
      languageLevel: cfVal(lead.custom_fields_values, CF.LANGUAGE_LEVEL),
      excludeFromAnalytics: cfBoolean(
        lead.custom_fields_values,
        CF.EXCLUDE_FROM_ANALYTICS,
      ),
      updatedAt: lead.updated_at ? new Date(lead.updated_at * 1000) : null,
    });
  }

  // Upsert: delete rows for these lead IDs, then insert fresh.
  // Use parameterized IN (...) instead of sql.raw to avoid injection risk
  // if `lead.id` is ever non-numeric in a malformed API response.
  const leadIds = rows.map((r) => r.leadId).filter((id): id is number => typeof id === "number" && Number.isFinite(id));

  if (leadIds.length > 0) {
    // Chunk to keep parameter count under the Postgres 65535-param limit.
    const DELETE_CHUNK = 5000;
    for (let i = 0; i < leadIds.length; i += DELETE_CHUNK) {
      const slice = leadIds.slice(i, i + DELETE_CHUNK);
      await analyticsDb.execute(sql`
        DELETE FROM analytics.leads_cohort
        WHERE lead_id IN (${sql.join(slice.map((id) => sql`${id}`), sql`, `)})
      `);
    }
  }

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
  const safe = leadIds.filter((id): id is number => typeof id === "number" && Number.isFinite(id));
  if (safe.length === 0) return;

  // Chunk for 65535-param limit.
  const CHUNK = 5000;
  for (let i = 0; i < safe.length; i += CHUNK) {
    const slice = safe.slice(i, i + CHUNK);
    await analyticsDb.execute(sql`
      UPDATE analytics.leads_cohort lc
      SET contact_date = sub.first_contact
      FROM (
        SELECT lead_id, MIN(created_at) AS first_contact
        FROM analytics.communications
        WHERE lead_id IN (${sql.join(slice.map((id) => sql`${id}`), sql`, `)})
        GROUP BY lead_id
      ) sub
      WHERE lc.lead_id = sub.lead_id
    `);
  }
}
