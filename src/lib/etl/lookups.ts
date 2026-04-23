// Kommo reference data: pipelines, users, loss_reasons
// Fetched once at the start of each ETL run and passed to all sync functions.

import { getPipelines, getUsers, getLossReasons } from "@/lib/kommo/client";

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
}

export async function fetchLookups(): Promise<KommoLookups> {
  const [rawPipelines, rawUsers, rawLossReasons] = await Promise.all([
    getPipelines(),
    getUsers(),
    getLossReasons(),
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

  console.log(`[ETL] Lookups: ${pipelines.size} pipelines, ${users.size} users, ${lossReasons.size} loss reasons`);
  return { pipelines, users, lossReasons };
}
