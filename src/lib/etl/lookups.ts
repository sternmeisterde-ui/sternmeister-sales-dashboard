// Kommo reference data: pipelines, users, loss_reasons
// Fetched once at the start of each ETL run and passed to all sync functions.

import { getPipelines, getUsers, getLossReasons, getLeadCustomFieldEnums } from "@/lib/kommo/client";
import { analyticsDb } from "@/lib/db/analytics";
import { refusalEnums as refusalEnumsTable } from "@/lib/db/schema-analytics";
import { sql as drSql } from "drizzle-orm";

/**
 * Kommo lead custom fields that hold closure-reason enums.
 * 879824 — "Причина закрытия Госники" (B2G main refusal reason field).
 * If Commerce has its own enum field, add its id here.
 */
const REFUSAL_ENUM_FIELD_IDS: number[] = [879824];

export interface StatusInfo {
  name: string;
  sort: number;
  type: number; // 0=normal, 1=won, 2=lost
}

export interface PipelineInfo {
  id: number;
  name: string;
  statuses: Map<number, StatusInfo>;
}

export interface KommoLookups {
  pipelines: Map<number, PipelineInfo>;
  users: Map<number, string>;       // kommoUserId → display name
  lossReasons: Map<number, string>; // lossReasonId → name
  /** enum_id → human-readable value, aggregated across REFUSAL_ENUM_FIELD_IDS. */
  refusalEnums: Map<number, string>;
}

export async function fetchLookups(): Promise<KommoLookups> {
  const [rawPipelines, rawUsers, rawLossReasons, ...rawEnumSets] = await Promise.all([
    getPipelines(),
    getUsers(),
    getLossReasons(),
    ...REFUSAL_ENUM_FIELD_IDS.map((id) => getLeadCustomFieldEnums(id)),
  ]);

  const pipelines = new Map<number, PipelineInfo>();
  for (const p of rawPipelines) {
    const statuses = new Map<number, StatusInfo>();
    for (const s of p._embedded.statuses) {
      statuses.set(s.id, { name: s.name, sort: s.sort, type: s.type });
    }
    pipelines.set(p.id, { id: p.id, name: p.name, statuses });
  }

  const users = new Map<number, string>();
  for (const u of rawUsers) {
    users.set(u.id, u.name);
  }

  const lossReasons = new Map<number, string>();
  for (const r of rawLossReasons) {
    lossReasons.set(r.id, r.name);
  }

  const refusalEnums = new Map<number, string>();
  const refusalRows: Array<{ enumId: number; value: string; fieldId: number }> = [];
  for (let i = 0; i < REFUSAL_ENUM_FIELD_IDS.length; i++) {
    const fieldId = REFUSAL_ENUM_FIELD_IDS[i];
    for (const e of rawEnumSets[i] ?? []) {
      refusalEnums.set(e.id, e.value);
      refusalRows.push({ enumId: e.id, value: e.value, fieldId });
    }
  }

  // Persist enum catalog so server-side SQL (e.g. getRefusalReasons) can translate
  // enum_id → human value without hitting Kommo on every render.
  if (refusalRows.length > 0) {
    try {
      await analyticsDb.execute(drSql`DELETE FROM analytics.refusal_enums`);
      for (const r of refusalRows) {
        await analyticsDb.insert(refusalEnumsTable).values(r);
      }
    } catch (e) {
      console.warn("[ETL] refusal_enums persist failed:", e);
    }
  }

  console.log(
    `[ETL] Lookups: ${pipelines.size} pipelines, ${users.size} users, ${lossReasons.size} loss reasons, ${refusalEnums.size} refusal enums`,
  );
  return { pipelines, users, lossReasons, refusalEnums };
}
