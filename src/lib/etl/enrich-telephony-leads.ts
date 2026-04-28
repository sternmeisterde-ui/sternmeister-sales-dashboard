// ETL step: phone → lead enrichment for telephony-sourced communications.
//
// Background: sync-telephony writes one row per CDR call leg with phone but
// without lead_id (the PBX writes the call before any Kommo lead exists for
// the phone). This step resolves each unenriched phone via Kommo
// /api/v4/contacts and fans out the row into one row per linked lead — the
// integrator's "Pattern A" semantics from docs/mysql-analytics.md so that
// Looker per-lead aggregations see telephony rows and SLA gets a real
// first_call_out_at.
//
// Idempotent: safe to re-run on the same window. Already-enriched rows have
// lead_id IS NOT NULL so they don't appear in the scan.
//
// Pattern:
//   1. SELECT comm_id, phone for unenriched call rows in window.
//   2. searchContactsByPhone(phones) → Map<phone, leadId[]>.
//   3. For each unenriched comm_id, look up its phone's leads.
//      - 0 matches: leave lead_id=NULL (next pass picks it up if Kommo
//        eventually registers a lead).
//      - N matches: UPDATE the first row with lead 1's metadata, INSERT
//        N-1 additional rows for leads 2..N. Lead metadata pulled from
//        analytics.leads_cohort (free; foreign-pipeline leads are skipped).
//   4. Log unresolved phones for diagnostics.

import { sql } from "drizzle-orm";
import { analyticsDb } from "@/lib/db/analytics";
import { searchContactsByPhone } from "@/lib/kommo/client";
import { getPipelineIds } from "@/lib/kommo/pipeline-config";

export interface EnrichResult {
  /** Rows scanned in the window with lead_id IS NULL AND phone IS NOT NULL */
  scannedRows: number;
  /** Distinct phones we asked Kommo about (after de-dup) */
  phonesQueried: number;
  /** Phones for which Kommo returned ≥1 contact-linked lead in our pipelines */
  phonesResolved: number;
  /** Rows in DB that ended up with a real lead_id after this pass */
  rowsLinked: number;
  /** Additional rows INSERTed (one per extra lead beyond the first) */
  rowsFannedOut: number;
  /** Phones we couldn't resolve at all — surface to logs for diagnostics */
  unresolvedPhones: string[];
}

interface UnenrichedRow {
  rowCtid: string; // PostgreSQL physical tuple id — used as primary identifier
                   // since analytics.communications has no PK and rows can
                   // share communication_id once we start fanning out.
  communicationId: string;
  phone: string;
  createdAt: Date;
  manager: string | null;
}

interface LeadMeta {
  leadId: number;
  pipelineId: number;
  pipelineName: string;
  statusId: number;
  statusName: string;
  category: string | null;
  utmSource: string | null;
  leadCreatedAt: Date;
}

/**
 * Run phone→lead enrichment for the [fromDate, toDate] window. Department-
 * scoped: only links leads in pipelines belonging to b2g + b2b (the union),
 * skipping foreign pipelines like webinars/test that the dashboards don't
 * surface.
 */
export async function enrichTelephonyLeads(
  fromDate: Date,
  toDate: Date,
): Promise<EnrichResult> {
  const result: EnrichResult = {
    scannedRows: 0,
    phonesQueried: 0,
    phonesResolved: 0,
    rowsLinked: 0,
    rowsFannedOut: 0,
    unresolvedPhones: [],
  };

  // Allowed pipelines: union of b2g + b2b. Foreign-pipeline leads from a
  // contact's lead list (webinars, test, аппеляции, etc.) are silently
  // dropped — the dashboards filter by these same pipeline ids, so linking
  // foreign leads would create dead rows.
  const allowedPipelines = new Set<number>([
    ...getPipelineIds("b2g"),
    ...getPipelineIds("b2b"),
  ]);

  // 1. Scan unenriched rows in window.
  const scanRes = await analyticsDb.execute<{
    ctid: string;
    communication_id: string;
    phone: string;
    created_at: string;
    manager: string | null;
  }>(sql`
    SELECT
      ctid::text   AS ctid,
      communication_id,
      phone,
      created_at,
      manager
    FROM analytics.communications
    WHERE lead_id IS NULL
      AND phone IS NOT NULL
      AND phone <> ''
      AND communication_type LIKE 'call%'
      AND created_at >= ${fromDate}
      AND created_at <= ${toDate}
  `);

  const unenriched: UnenrichedRow[] = scanRes.rows.map((r) => ({
    rowCtid: r.ctid,
    communicationId: r.communication_id,
    phone: r.phone,
    createdAt: typeof r.created_at === "string"
      ? new Date(`${r.created_at.replace(" ", "T")}Z`)
      : new Date(r.created_at),
    manager: r.manager,
  }));
  result.scannedRows = unenriched.length;
  if (unenriched.length === 0) {
    console.log(`[ETL enrich] window ${fromDate.toISOString()}..${toDate.toISOString()}: 0 unenriched rows`);
    return result;
  }

  // 2. De-dup phones, then batch-resolve via Kommo.
  const distinctPhones = Array.from(new Set(unenriched.map((r) => r.phone)));
  result.phonesQueried = distinctPhones.length;
  console.log(
    `[ETL enrich] scanning ${unenriched.length} unenriched rows across ${distinctPhones.length} distinct phones`,
  );

  const phoneToLeadIds = await searchContactsByPhone(distinctPhones);

  // 3. Collect every lead id we need metadata for, then bulk-fetch from
  //    analytics.leads_cohort. One round-trip even for 10k rows.
  const allLeadIds = new Set<number>();
  for (const ids of phoneToLeadIds.values()) {
    for (const id of ids) allLeadIds.add(id);
  }

  let leadMetaById = new Map<number, LeadMeta>();
  if (allLeadIds.size > 0) {
    const leadIdList = Array.from(allLeadIds);
    const leadRes = await analyticsDb.execute<{
      lead_id: number | string;
      pipeline_id: number | string | null;
      pipeline: string | null;
      status_id: number | string | null;
      status: string | null;
      category: string | null;
      utm_source: string | null;
      created_at: string | null;
    }>(sql`
      SELECT lead_id, pipeline_id, pipeline, status_id, status, category, utm_source, created_at
      FROM analytics.leads_cohort
      WHERE lead_id IN (${sql.raw(leadIdList.join(","))})
    `);

    for (const row of leadRes.rows) {
      const pid = row.pipeline_id != null ? Number(row.pipeline_id) : 0;
      if (!allowedPipelines.has(pid)) continue; // skip foreign-pipeline leads
      leadMetaById.set(Number(row.lead_id), {
        leadId: Number(row.lead_id),
        pipelineId: pid,
        pipelineName: row.pipeline ?? "",
        statusId: row.status_id != null ? Number(row.status_id) : 0,
        statusName: row.status ?? "",
        category: row.category,
        utmSource: row.utm_source,
        leadCreatedAt: row.created_at
          ? new Date(`${String(row.created_at).replace(" ", "T")}Z`)
          : new Date(0),
      });
    }
  }

  // 4. Apply enrichment. Group by phone to know how to map first-row UPDATE
  //    vs additional INSERTs. Group rows already at scan time.
  const rowsByPhone = new Map<string, UnenrichedRow[]>();
  for (const r of unenriched) {
    let bucket = rowsByPhone.get(r.phone);
    if (!bucket) {
      bucket = [];
      rowsByPhone.set(r.phone, bucket);
    }
    bucket.push(r);
  }

  // Counter for tracking fan-out across phones.
  const unresolvedSet = new Set<string>();
  let phonesResolved = 0;
  let rowsLinked = 0;
  let rowsFannedOut = 0;

  // Iterate phones; do all DB writes per phone in one transaction batch
  // through analyticsDb.execute (Neon HTTP — no transactions, but each
  // statement is atomic and we don't depend on cross-statement consistency).
  for (const [phone, rows] of rowsByPhone) {
    const linkedLeadIds = phoneToLeadIds.get(phone) ?? [];
    const matchingLeads: LeadMeta[] = [];
    for (const lid of linkedLeadIds) {
      const meta = leadMetaById.get(lid);
      if (meta) matchingLeads.push(meta);
    }

    if (matchingLeads.length === 0) {
      unresolvedSet.add(phone);
      continue;
    }

    phonesResolved++;

    // For each unenriched row of this phone, write the same lead set.
    // Different rows of the same phone are different CDR records (different
    // calls) — each gets its own fan-out.
    //
    // ORDER MATTERS: INSERT secondary copies FIRST (while the source row's
    // ctid still resolves), THEN UPDATE the primary. UPDATE in PostgreSQL
    // creates a new MVCC tuple version at a fresh ctid, so a subsequent
    // INSERT...SELECT WHERE ctid = original would silently match 0 rows.
    // Bug discovered 2026-04-28 smoke: 264 fan-out INSERTs executed but
    // 0 rows landed. The conflict target is fine; ctid was the issue.
    for (const row of rows) {
      const [primary, ...secondary] = matchingLeads;

      // 4a. INSERT additional rows for leads 2..N — must happen before the
      // UPDATE so ctid is still valid. ON CONFLICT DO NOTHING handles the
      // rare race where a concurrent run already wrote (comm_id, lead_id).
      for (const extra of secondary) {
        await analyticsDb.execute(sql`
          INSERT INTO analytics.communications (
            communication_id, communication_type, entity_id, created_at,
            lead_id, pipeline_id, pipeline_name, category, lead_created_at,
            lead_day_start, call_status, duration, manager,
            status_id, status_name, utm_source,
            first_contact_flg, last_contact_flg, first_call_at,
            business_hours_sla, business_hours_since_communication, phone
          )
          SELECT
            communication_id, communication_type, entity_id, created_at,
            ${extra.leadId} AS lead_id,
            ${extra.pipelineId} AS pipeline_id,
            ${extra.pipelineName} AS pipeline_name,
            ${extra.category} AS category,
            ${extra.leadCreatedAt} AS lead_created_at,
            lead_day_start, call_status, duration, manager,
            ${extra.statusId} AS status_id,
            ${extra.statusName} AS status_name,
            COALESCE(utm_source, ${extra.utmSource}) AS utm_source,
            first_contact_flg, last_contact_flg, first_call_at,
            business_hours_sla, business_hours_since_communication, phone
          FROM analytics.communications
          WHERE ctid = ${row.rowCtid}::tid
          ON CONFLICT (communication_id, COALESCE(lead_id, 0))
            WHERE communication_id IS NOT NULL
            DO NOTHING
        `);
        rowsFannedOut++;
      }

      // 4b. UPDATE the raw row in place with the primary lead's metadata.
      // After this UPDATE the ctid is invalidated — must run last.
      await analyticsDb.execute(sql`
        UPDATE analytics.communications
        SET
          lead_id          = ${primary.leadId},
          pipeline_id      = ${primary.pipelineId},
          pipeline_name    = ${primary.pipelineName},
          status_id        = ${primary.statusId},
          status_name      = ${primary.statusName},
          category         = ${primary.category},
          utm_source       = COALESCE(communications.utm_source, ${primary.utmSource}),
          lead_created_at  = ${primary.leadCreatedAt}
        WHERE ctid = ${row.rowCtid}::tid
      `);
      rowsLinked++;
    }
  }

  result.phonesResolved = phonesResolved;
  result.rowsLinked = rowsLinked;
  result.rowsFannedOut = rowsFannedOut;
  result.unresolvedPhones = Array.from(unresolvedSet);

  console.log(
    `[ETL enrich] done: phones queried=${result.phonesQueried} resolved=${result.phonesResolved}` +
    ` rowsLinked=${result.rowsLinked} rowsFannedOut=${result.rowsFannedOut}` +
    ` unresolved=${result.unresolvedPhones.length}`,
  );
  if (result.unresolvedPhones.length > 0 && result.unresolvedPhones.length < 30) {
    console.log(`[ETL enrich] sample unresolved: ${result.unresolvedPhones.slice(0, 30).join(", ")}`);
  }

  return result;
}
