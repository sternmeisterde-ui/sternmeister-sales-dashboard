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
// Pattern (bulk-optimised 2026-04-28):
//   1. Scan: pull EVERY column needed for INSERT, not just ctid+phone, so
//      we can build full INSERT records in JS without re-reading the row.
//   2. searchContactsByPhone(phones) → Map<phone, leadId[]>.
//   3. Look up lead metadata (pipeline_id, status, etc.) from leads_cohort
//      in one round-trip.
//   4. Build two arrays in JS:
//        - updateRecs[] — one entry per row, sets primary lead's metadata.
//        - insertRecs[] — N-1 entries per row with ≥2 leads (fan-out copies).
//      Then issue:
//        - ONE bulk INSERT per 500-row batch via jsonb_to_recordset.
//        - ONE bulk UPDATE per 500-row batch via jsonb_to_recordset.
//      Order matters: INSERT first while ctids still resolve. UPDATE last
//      because UPDATE invalidates ctid (PostgreSQL MVCC creates a new tuple
//      version, so any subsequent INSERT...SELECT FROM ctid would no-op).
//
// Throughput: 1 SELECT + N Kommo lookups + 2 bulk SQL per 500-batch. Was
// previously 1 SELECT + N Kommo lookups + ≥1 INSERT + 1 UPDATE PER ROW.
// 100k+ Neon HTTP roundtrips collapsed to ~50, eliminating the retry storm
// observed during the parallel-worker attempt.

import { sql } from "drizzle-orm";
import { analyticsDb } from "@/lib/db/analytics";
import { searchContactsByPhone } from "@/lib/kommo/client";
import { getPipelineIds } from "@/lib/kommo/pipeline-config";
import { APP_TZ, parseDateBoundary } from "@/lib/utils/date";

/** Truncate an ISO/timestamp string to the start of its Berlin-local civil
 *  day, returned as an ISO string. Mirrors `berlinDayStart` in
 *  sync-communications.ts but works with strings since enrichment passes
 *  lead_created_at as text from leads_cohort. Returns null if input is empty. */
function berlinDayStartIso(leadCreatedAt: string | null): string | null {
  if (!leadCreatedAt) return null;
  const civil = new Date(leadCreatedAt).toLocaleDateString("en-CA", {
    timeZone: APP_TZ,
  });
  return parseDateBoundary(civil, "start")?.toISOString() ?? null;
}

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
  /** Total unenriched rows still pending after this tick. Used by alerting
   * to detect a stuck backlog — if this stays flat or grows across ticks,
   * Kommo lookups are failing or unresolved phones outnumber the cap. */
  backlogRemaining: number;
}

/** Carries every column we need to either UPDATE in place or copy into a fan-out INSERT. */
interface UnenrichedRow {
  rowCtid: string;
  communicationId: string | null;
  communicationType: string | null;
  entityId: number | null;
  createdAt: string | null;          // raw timestamp string from PG (no-tz)
  manager: string | null;
  phone: string;
  callStatus: number | null;
  duration: number | null;
  leadDayStart: string | null;
  firstContactFlg: number | null;
  lastContactFlg: number | null;
  firstCallAt: string | null;
  businessHoursSla: number | null;
  businessHoursSinceCommunication: number | null;
  waitSeconds: number | null;
  lineName: string | null;
  pbxSource: string | null;
}

interface LeadMeta {
  leadId: number;
  pipelineId: number;
  pipelineName: string;
  statusId: number;
  statusName: string;
  category: string | null;
  utmSource: string | null;
  leadCreatedAt: string;             // ISO string
}

interface UpdateRecord {
  ctid: string;
  lead_id: number;
  pipeline_id: number;
  pipeline_name: string;
  status_id: number;
  status_name: string;
  category: string | null;
  utm_source: string | null;
  lead_created_at: string;
}

interface InsertRecord {
  communication_id: string | null;
  communication_type: string | null;
  entity_id: number | null;
  created_at: string | null;
  lead_id: number;
  pipeline_id: number;
  pipeline_name: string;
  category: string | null;
  lead_created_at: string;
  lead_day_start: string | null;
  call_status: number | null;
  duration: number | null;
  manager: string | null;
  status_id: number;
  status_name: string;
  utm_source: string | null;
  first_contact_flg: number | null;
  last_contact_flg: number | null;
  first_call_at: string | null;
  business_hours_sla: number | null;
  business_hours_since_communication: number | null;
  phone: string;
  wait_seconds: number | null;
  line_name: string | null;
  pbx_source: string | null;
}

/** Batch size for bulk SQL — keep JSON payload under ~1MB to stay well below Neon's HTTP body cap. */
const BULK_BATCH_SIZE = 500;

/**
 * Local-first резолв телефона в сделки (2026-07-02, решение владельца:
 * «зачем каждый раз обращаться к Kommo»): телефон → analytics.contacts
 * (матч по последним 10 цифрам ЛЮБОГО номера контакта из phones_all) →
 * lead_contact_links (is_active) → lead_ids. Зеркало contacts/links
 * наполняется штатным ETL (sync-leads → sync-contacts), покрытие бэклога
 * ~99.9% (замер diag-local-enrich-coverage.ts). Kommo остаётся fallback'ом
 * только для номеров, которых зеркало ещё не видело (совсем свежие
 * контакты между тиками) — постоянная нагрузка на Kommo падает почти до
 * нуля (правило владельца ≤1 rps соблюдается с запасом).
 *
 * Порядок lead_ids — по возрастанию id (≈ порядок создания, тот же принцип,
 * что у Kommo `_embedded.leads`) — выбор primary-лида детерминирован.
 * Короткие/пустые номера (<6 цифр) не матчим — это служебные наборы.
 */
export async function resolvePhonesLocally(phones: string[]): Promise<Map<string, number[]>> {
  const map = new Map<string, number[]>();
  if (phones.length === 0) return map;
  const json = JSON.stringify(phones.map((p) => ({ phone: p })));
  const res = await analyticsDb.execute<{ phone: string; lead_ids: Array<number | string> }>(sql`
    WITH input AS (
      SELECT i.phone, right(regexp_replace(i.phone, '\D', '', 'g'), 10) AS pnorm
      FROM jsonb_to_recordset(${json}::jsonb) AS i(phone text)
    ),
    contact_phones AS (
      SELECT c.contact_id, right(regexp_replace(p.v, '\D', '', 'g'), 10) AS pnorm
      FROM analytics.contacts c,
           jsonb_array_elements_text(COALESCE(c.phones_all, '[]'::jsonb)) AS p(v)
    )
    SELECT i.phone, array_agg(DISTINCT l.lead_id ORDER BY l.lead_id) AS lead_ids
    FROM input i
    JOIN contact_phones cp
      ON cp.pnorm = i.pnorm AND i.pnorm <> '' AND length(i.pnorm) >= 6
    JOIN analytics.lead_contact_links l
      ON l.contact_id = cp.contact_id AND l.is_active
    GROUP BY i.phone
  `);
  for (const r of res.rows) {
    map.set(r.phone, (r.lead_ids ?? []).map(Number));
  }
  return map;
}

/**
 * Per-tick scan cap. This is a *row* cap, not a phone cap — multiple rows
 * can share the same phone (one caller, multiple CDR legs). Phones are
 * de-duplicated inside `searchContactsByPhone`, so the effective Kommo
 * request count is `≤ MAX_ROWS_PER_TICK`, not `=`.
 *
 * Bounded by the Kommo /contacts rate limit (~1 rps per token, 1 request
 * per unique phone — see src/lib/kommo/client.ts) and the cron route's
 * `maxDuration = 300s` and the 6-min lease. Worst case: 200 distinct
 * phones × 1 sec ≈ 3m20s — leaves ~80s headroom inside maxDuration for
 * the bulk INSERT/UPDATE + the rest of the ETL pipeline. Going higher
 * (we tried 300, then 800) caused DASHBOARD-4 / DASHBOARD-N: a single
 * slow phone (Kommo's 30s timeout firing) pushed the tick past maxDuration
 * and Neon aborted mid-statement.
 *
 * Oldest rows first (ORDER BY created_at) so backfill / replay work
 * doesn't starve fresh tick rows. Backlog size is reported separately so
 * /api/health/etl can fire `degraded` when it stops shrinking across ticks
 * — the long-term fix for that case is the unresolvable-phone decoupling
 * tracked in follow-up #10.
 */
const MAX_ROWS_PER_TICK = 200;

/**
 * Run phone→lead enrichment for the [fromDate, toDate] window. Department-
 * scoped: only links leads in pipelines belonging to b2g + b2b (the union),
 * skipping foreign pipelines like webinars/test that the dashboards don't
 * surface.
 *
 * Sweep mode: when called from the 15-min cron, the toDate window is too
 * tight to retry rows whose Kommo contact wasn't yet known at first
 * attempt. Pass `lookbackDays` (e.g., 7) to widen the from-date so each
 * tick re-tries old failures. Without this, telephony rows that landed
 * before Kommo had the contact stay lead_id=NULL forever and SLA never
 * picks up their first_call_out_at.
 */
export async function enrichTelephonyLeads(
  fromDate: Date,
  toDate: Date,
  options: { lookbackDays?: number } = {},
): Promise<EnrichResult> {
  const lookbackDays = options.lookbackDays;
  const effectiveFromDate = lookbackDays !== undefined && lookbackDays > 0
    ? new Date(toDate.getTime() - lookbackDays * 24 * 60 * 60 * 1000)
    : fromDate;
  const result: EnrichResult = {
    scannedRows: 0,
    phonesQueried: 0,
    phonesResolved: 0,
    rowsLinked: 0,
    rowsFannedOut: 0,
    unresolvedPhones: [],
    backlogRemaining: 0,
  };

  const allowedPipelines = new Set<number>([
    ...getPipelineIds("b2g"),
    ...getPipelineIds("b2b"),
  ]);

  // 1. Scan unenriched rows in window — pull EVERY column we'll need to
  // either UPDATE in place or replicate into fan-out INSERTs. Capped by
  // MAX_ROWS_PER_TICK and ordered by created_at ASC so older backlog drains
  // first instead of being starved by fresh-window rows. Whatever doesn't
  // fit this tick is reported via `backlogRemaining` and picked up next
  // tick — bounded latency under load instead of an unbounded slow scan.
  // LEFT JOIN against analytics.enrich_skip_phones — phones already tried
  // and known to return 0 Kommo contact matches stay out of the scan.
  // Without this filter the oldest 200 rows of the queue were dominated
  // by ~28 dead-letter phones for months, blocking newer resolvable rows
  // from ever being scanned (migration 0016 added the table).
  const scanRes = await analyticsDb.execute<{
    ctid: string;
    communication_id: string | null;
    communication_type: string | null;
    entity_id: string | number | null;
    created_at: string | null;
    manager: string | null;
    phone: string;
    call_status: number | null;
    duration: number | null;
    lead_day_start: string | null;
    first_contact_flg: number | null;
    last_contact_flg: number | null;
    first_call_at: string | null;
    business_hours_sla: string | number | null;
    business_hours_since_communication: number | null;
    wait_seconds: number | null;
    line_name: string | null;
    pbx_source: string | null;
  }>(sql`
    SELECT
      c.ctid::text                                     AS ctid,
      c.communication_id,
      c.communication_type,
      c.entity_id,
      c.created_at::text                               AS created_at,
      c.manager,
      c.phone,
      c.call_status,
      c.duration,
      c.lead_day_start::text                           AS lead_day_start,
      c.first_contact_flg,
      c.last_contact_flg,
      c.first_call_at::text                            AS first_call_at,
      c.business_hours_sla,
      c.business_hours_since_communication,
      c.wait_seconds,
      c.line_name,
      c.pbx_source
    FROM analytics.communications c
    LEFT JOIN analytics.enrich_skip_phones s ON s.phone = c.phone
    WHERE c.lead_id IS NULL
      AND c.phone IS NOT NULL
      AND c.phone <> ''
      AND c.communication_type LIKE 'call%'
      AND c.created_at >= ${effectiveFromDate}
      AND c.created_at <= ${toDate}
      AND s.phone IS NULL
    ORDER BY c.created_at ASC
    LIMIT ${MAX_ROWS_PER_TICK}
  `);

  // Total backlog (incl. rows past the cap) — separate fast COUNT so the
  // tick still reports honest queue depth even when capped. Used by the
  // /api/health/etl endpoint and the dashboard freshness badge.
  // Same skip-list filter as the scan so the reported backlog reflects
  // actionable work, not the dead-letter set we've decided not to retry.
  const backlogRes = await analyticsDb.execute<{ n: string | number }>(sql`
    SELECT COUNT(*) AS n
    FROM analytics.communications c
    LEFT JOIN analytics.enrich_skip_phones s ON s.phone = c.phone
    WHERE c.lead_id IS NULL
      AND c.phone IS NOT NULL
      AND c.phone <> ''
      AND c.communication_type LIKE 'call%'
      AND c.created_at >= ${effectiveFromDate}
      AND c.created_at <= ${toDate}
      AND s.phone IS NULL
  `);
  result.backlogRemaining = Number(backlogRes.rows[0]?.n ?? 0);

  const unenriched: UnenrichedRow[] = scanRes.rows.map((r) => ({
    rowCtid: r.ctid,
    communicationId: r.communication_id,
    communicationType: r.communication_type,
    entityId: r.entity_id != null ? Number(r.entity_id) : null,
    createdAt: r.created_at,
    manager: r.manager,
    phone: r.phone,
    callStatus: r.call_status,
    duration: r.duration,
    leadDayStart: r.lead_day_start,
    firstContactFlg: r.first_contact_flg,
    lastContactFlg: r.last_contact_flg,
    firstCallAt: r.first_call_at,
    businessHoursSla: r.business_hours_sla != null ? Number(r.business_hours_sla) : null,
    businessHoursSinceCommunication: r.business_hours_since_communication,
    waitSeconds: r.wait_seconds != null ? Number(r.wait_seconds) : null,
    lineName: r.line_name ?? null,
    pbxSource: r.pbx_source ?? null,
  }));
  result.scannedRows = unenriched.length;
  if (unenriched.length === 0) {
    console.log(
      `[ETL enrich] window ${effectiveFromDate.toISOString()}..${toDate.toISOString()}: 0 unenriched rows (backlog=${result.backlogRemaining})`,
    );
    return result;
  }

  // 2. De-dup phones, then batch-resolve via Kommo.
  const distinctPhones = Array.from(new Set(unenriched.map((r) => r.phone)));
  result.phonesQueried = distinctPhones.length;
  const cappedNote =
    result.backlogRemaining > unenriched.length
      ? ` (CAPPED — ${result.backlogRemaining - unenriched.length} more pending)`
      : "";
  console.log(
    `[ETL enrich] scanning ${unenriched.length} unenriched rows across ${distinctPhones.length} distinct phones${cappedNote}`,
  );

  // Local-first: сначала зеркало contacts/links, Kommo — только для промахов.
  // Merged-map сохраняет семантику skip-листа: запись в map = «получили
  // определённый ответ» (локальный хит ИЛИ ответ Kommo, включая пустой);
  // Kommo-таймауты в map не попадают → не skip-листятся, ретрай следующим
  // тиком — как и раньше.
  const localMap = await resolvePhonesLocally(distinctPhones);
  const missingPhones = distinctPhones.filter((p) => !(localMap.get(p)?.length));
  const kommoMap =
    missingPhones.length > 0
      ? await searchContactsByPhone(missingPhones)
      : new Map<string, number[]>();
  const phoneToLeadIds = new Map<string, number[]>();
  for (const [p, ids] of localMap) {
    if (ids.length > 0) phoneToLeadIds.set(p, ids);
  }
  for (const [p, ids] of kommoMap) {
    if (!phoneToLeadIds.has(p)) phoneToLeadIds.set(p, ids);
  }
  console.log(
    `[ETL enrich] resolve: local=${distinctPhones.length - missingPhones.length}, kommo-fallback=${missingPhones.length}`,
  );

  // 3. Bulk-fetch lead metadata from leads_cohort.
  const allLeadIds = new Set<number>();
  for (const ids of phoneToLeadIds.values()) {
    for (const id of ids) allLeadIds.add(id);
  }

  const leadMetaById = new Map<number, LeadMeta>();
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
      SELECT
        lead_id,
        pipeline_id,
        pipeline,
        status_id,
        status,
        category,
        utm_source,
        created_at::text AS created_at
      FROM analytics.leads_cohort
      WHERE lead_id IN (${sql.raw(leadIdList.join(","))})
    `);

    for (const row of leadRes.rows) {
      const pid = row.pipeline_id != null ? Number(row.pipeline_id) : 0;
      if (!allowedPipelines.has(pid)) continue;
      leadMetaById.set(Number(row.lead_id), {
        leadId: Number(row.lead_id),
        pipelineId: pid,
        pipelineName: row.pipeline ?? "",
        statusId: row.status_id != null ? Number(row.status_id) : 0,
        statusName: row.status ?? "",
        category: row.category,
        utmSource: row.utm_source,
        leadCreatedAt: row.created_at ?? "1970-01-01 00:00:00",
      });
    }
  }

  // 4. Build update + insert records. Group rows by phone so the lead set is
  //    resolved once per phone, not per row.
  const rowsByPhone = new Map<string, UnenrichedRow[]>();
  for (const r of unenriched) {
    let bucket = rowsByPhone.get(r.phone);
    if (!bucket) {
      bucket = [];
      rowsByPhone.set(r.phone, bucket);
    }
    bucket.push(r);
  }

  const updateRecs: UpdateRecord[] = [];
  const insertRecs: InsertRecord[] = [];
  const unresolvedSet = new Set<string>();
  let phonesResolved = 0;

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

    // Dedup raw rows by communication_id — sync-telephony's prefix-scoped
    // DELETE-then-INSERT can leave 2+ physical rows sharing one communication_id
    // when an upstream retry races (sync ran twice on the same window).
    // Without this dedup, the bulk UPDATE produces N updates with the same
    // (communication_id, lead_id) pair → second one violates
    // communications_comm_lead_unique constraint and the whole batch aborts.
    const seenCommId = new Set<string>();
    const dedupedRows = rows.filter((r) => {
      // Rows without a communication_id can't violate the
      // (communication_id, lead_id) unique constraint, so let them all through.
      if (!r.communicationId) return true;
      if (seenCommId.has(r.communicationId)) return false;
      seenCommId.add(r.communicationId);
      return true;
    });

    for (const row of dedupedRows) {
      const [primary, ...secondary] = matchingLeads;

      // UPDATE the original row with primary lead's metadata.
      updateRecs.push({
        ctid: row.rowCtid,
        lead_id: primary.leadId,
        pipeline_id: primary.pipelineId,
        pipeline_name: primary.pipelineName,
        status_id: primary.statusId,
        status_name: primary.statusName,
        category: primary.category,
        utm_source: primary.utmSource,
        lead_created_at: primary.leadCreatedAt,
      });

      // INSERT a fan-out copy for each additional lead.
      for (const extra of secondary) {
        insertRecs.push({
          communication_id: row.communicationId,
          communication_type: row.communicationType,
          entity_id: row.entityId,
          created_at: row.createdAt,
          lead_id: extra.leadId,
          pipeline_id: extra.pipelineId,
          pipeline_name: extra.pipelineName,
          category: extra.category,
          lead_created_at: extra.leadCreatedAt,
          // The fan-out row belongs to a *different* lead than the source —
          // its cohort bucket must be that lead's Berlin day-start, not the
          // source row's. Looker / Daily group by `lead_day_start` for daily
          // aggregations, so copying the source's value silently mis-buckets
          // calls that span midnight or fan out to leads created on a
          // different day.
          lead_day_start: berlinDayStartIso(extra.leadCreatedAt) ?? row.leadDayStart,
          call_status: row.callStatus,
          duration: row.duration,
          manager: row.manager,
          status_id: extra.statusId,
          status_name: extra.statusName,
          utm_source: extra.utmSource,
          first_contact_flg: row.firstContactFlg,
          last_contact_flg: row.lastContactFlg,
          first_call_at: row.firstCallAt,
          business_hours_sla: row.businessHoursSla,
          business_hours_since_communication: row.businessHoursSinceCommunication,
          phone: row.phone,
          wait_seconds: row.waitSeconds,
          line_name: row.lineName,
          pbx_source: row.pbxSource,
        });
      }
    }
  }

  // 5. Apply in bulk. INSERTs first (rely on stable ctids), UPDATEs second.
  // Both use jsonb_to_recordset so a 500-row batch is one Neon HTTP call.
  if (insertRecs.length > 0) {
    for (let i = 0; i < insertRecs.length; i += BULK_BATCH_SIZE) {
      const batch = insertRecs.slice(i, i + BULK_BATCH_SIZE);
      await bulkInsertFanouts(batch);
    }
  }

  if (updateRecs.length > 0) {
    for (let i = 0; i < updateRecs.length; i += BULK_BATCH_SIZE) {
      const batch = updateRecs.slice(i, i + BULK_BATCH_SIZE);
      await bulkUpdatePrimaries(batch);
    }
  }

  result.phonesResolved = phonesResolved;
  result.rowsLinked = updateRecs.length;
  result.rowsFannedOut = insertRecs.length;
  result.unresolvedPhones = Array.from(unresolvedSet);

  // 6. Record unresolved phones in the skip-list so the next tick's scan
  //    bypasses them. We DON'T mark a phone skipped if its Kommo lookup
  //    threw a network/timeout error — that's a transient failure and the
  //    phone should be retried later. `phoneToLeadIds` only contains
  //    entries for phones we actually got a response for (resolved OR
  //    explicit zero-hit), so iterating its keys filters out timeouts.
  if (result.unresolvedPhones.length > 0) {
    const definitivelyUnresolved = result.unresolvedPhones.filter((p) =>
      phoneToLeadIds.has(p),
    );
    if (definitivelyUnresolved.length > 0) {
      const json = JSON.stringify(definitivelyUnresolved.map((p) => ({ phone: p })));
      await analyticsDb.execute(sql`
        INSERT INTO analytics.enrich_skip_phones (phone)
        SELECT i.phone
        FROM jsonb_to_recordset(${json}::jsonb) AS i(phone text)
        ON CONFLICT (phone) DO UPDATE
          SET attempts          = analytics.enrich_skip_phones.attempts + 1,
              last_attempted_at = now()
      `);
    }
  }

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

/**
 * Bulk UPDATE: one statement, N rows. The records are passed as a single
 * jsonb parameter (jsonb_to_recordset parses it server-side). Saves N×
 * Neon HTTP roundtrips.
 */
async function bulkUpdatePrimaries(batch: UpdateRecord[]): Promise<void> {
  const json = JSON.stringify(batch);
  await analyticsDb.execute(sql`
    UPDATE analytics.communications c
    SET
      lead_id          = u.lead_id,
      pipeline_id      = u.pipeline_id,
      pipeline_name    = u.pipeline_name,
      status_id        = u.status_id,
      status_name      = u.status_name,
      category         = u.category,
      utm_source       = COALESCE(c.utm_source, u.utm_source),
      lead_created_at  = u.lead_created_at::timestamp
    FROM jsonb_to_recordset(${json}::jsonb) AS u(
      ctid              text,
      lead_id           bigint,
      pipeline_id       bigint,
      pipeline_name     text,
      status_id         bigint,
      status_name       text,
      category          text,
      utm_source        text,
      lead_created_at   text
    )
    WHERE c.ctid = u.ctid::tid
  `);
}

/**
 * Bulk INSERT: one statement, N rows. ON CONFLICT DO NOTHING handles re-run
 * idempotency — if the (comm_id, lead_id) pair already exists from a prior
 * run, we silently skip it.
 */
async function bulkInsertFanouts(batch: InsertRecord[]): Promise<void> {
  const json = JSON.stringify(batch);
  await analyticsDb.execute(sql`
    INSERT INTO analytics.communications (
      communication_id, communication_type, entity_id, created_at,
      lead_id, pipeline_id, pipeline_name, category, lead_created_at,
      lead_day_start, call_status, duration, manager,
      status_id, status_name, utm_source,
      first_contact_flg, last_contact_flg, first_call_at,
      business_hours_sla, business_hours_since_communication, phone,
      wait_seconds, line_name, pbx_source
    )
    SELECT
      i.communication_id, i.communication_type, i.entity_id, i.created_at::timestamp,
      i.lead_id, i.pipeline_id, i.pipeline_name, i.category, i.lead_created_at::timestamp,
      i.lead_day_start::timestamp, i.call_status, i.duration, i.manager,
      i.status_id, i.status_name, i.utm_source,
      i.first_contact_flg, i.last_contact_flg, i.first_call_at::timestamp,
      i.business_hours_sla, i.business_hours_since_communication, i.phone,
      i.wait_seconds, i.line_name, i.pbx_source
    FROM jsonb_to_recordset(${json}::jsonb) AS i(
      communication_id                 text,
      communication_type               text,
      entity_id                        bigint,
      created_at                       text,
      lead_id                          bigint,
      pipeline_id                      bigint,
      pipeline_name                    text,
      category                         text,
      lead_created_at                  text,
      lead_day_start                   text,
      call_status                      smallint,
      duration                         integer,
      manager                          text,
      status_id                        bigint,
      status_name                      text,
      utm_source                       text,
      first_contact_flg                smallint,
      last_contact_flg                 smallint,
      first_call_at                    text,
      business_hours_sla               bigint,
      business_hours_since_communication double precision,
      phone                            text,
      wait_seconds                     integer,
      line_name                        text,
      pbx_source                       text
    )
    ON CONFLICT (communication_id, COALESCE(lead_id, 0))
      WHERE communication_id IS NOT NULL
      DO NOTHING
  `);
}
