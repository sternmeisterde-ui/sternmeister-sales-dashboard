// Re-pull lead_status_changed events from Kommo over a window and upsert them
// into analytics.lead_status_changes via the regular ETL step (idempotent
// ON CONFLICT upsert + next_* window recompute).
//
// Why: failed cron ticks left gaps — transitions that exist in Kommo /events
// but never landed in our mirror. Diagnosed 2026-07-22: 1583 Бух Гос leads
// whose latest captured event disagrees with the leads_cohort snapshot, which
// corrupts historical stage reconstruction (dialer «Касания по лидам» table,
// Регламент intervals). A window re-pull recovers them without per-lead calls.
//
// Run from repo root (Kommo rate ≤1 rps enforced by the client):
//   npx tsx scripts/backfill-status-changes.ts                            # events horizon → today
//   npx tsx scripts/backfill-status-changes.ts --from 2026-06-01 --to 2026-07-22
//   npx tsx scripts/backfill-status-changes.ts --chunk 3                  # days per chunk
//
// Requires .env.local with: ANALYTICS_DATABASE_URL, KOMMO_ACCESS_TOKEN (or
// kommo_tokens row in D1 + KOMMO_TOKEN_SOURCE=db → also DATABASE_URL).

import { config } from "dotenv";
import { resolve } from "node:path";
import dns from "node:dns";
import net from "node:net";

// IPv4-first как в src/instrumentation.ts: на сетях с битым IPv6 Neon-драйвер
// иначе виснет на AAAA-адресе до таймаута (см. memory neon-ipv6-hang).
dns.setDefaultResultOrder("ipv4first");
net.setDefaultAutoSelectFamily(true);
net.setDefaultAutoSelectFamilyAttemptTimeout(500);

config({ path: resolve(process.cwd(), ".env.local") });

import { syncStatusChanges } from "../src/lib/etl/sync-status-changes";
import { fetchLookups } from "../src/lib/etl/lookups";
import type { LeadCacheEntry } from "../src/lib/etl/sync-leads";
import { analyticsDb } from "../src/lib/db/analytics";
import { sql } from "drizzle-orm";

// Earliest event in analytics.lead_status_changes (2025-11-08) — pulling
// before that is pointless: Kommo /events retention starts nearby anyway.
const DEFAULT_FROM = "2025-11-01";

function arg(name: string, def: string | null = null): string | null {
  const args = process.argv.slice(2);
  const idx = args.indexOf(`--${name}`);
  if (idx < 0) return def;
  return args[idx + 1] ?? def;
}

async function loadLeadCache(): Promise<LeadCacheEntry[]> {
  // syncStatusChanges only reads leadId/createdAt/manager from the cache
  // (for lead_created_at / manager snapshots); the rest are placeholders.
  const res = await (analyticsDb as unknown as {
    execute: <T>(q: unknown) => Promise<{ rows: T[] }>;
  }).execute<{
    lead_id: string | number;
    created_at: string | null;
    pipeline_id: string | number | null;
    status_id: string | number | null;
    manager: string | null;
    responsible_user_id: string | number | null;
  }>(sql`
    SELECT lead_id, created_at, pipeline_id, status_id, manager, responsible_user_id
    FROM analytics.leads_cohort
    WHERE lead_id IS NOT NULL
  `);
  return res.rows.map((r) => ({
    leadId: Number(r.lead_id),
    createdAt: r.created_at ? new Date(r.created_at) : new Date(0),
    pipelineId: Number(r.pipeline_id ?? 0),
    pipelineName: "",
    statusId: Number(r.status_id ?? 0),
    statusName: "",
    statusOrder: 0,
    category: null,
    manager: r.manager ?? null,
    responsibleUserId: Number(r.responsible_user_id ?? 0),
  })) as LeadCacheEntry[];
}

async function main() {
  const fromISO = arg("from", DEFAULT_FROM)!;
  const toISO = arg("to", new Date().toISOString().slice(0, 10))!;
  const chunkDays = Number(arg("chunk", "7"));

  console.log(`[backfill-status-changes] ${fromISO} → ${toISO}, chunk=${chunkDays}d`);

  const lookups = await fetchLookups();
  const leadCache = await loadLeadCache();
  console.log(`[backfill-status-changes] leadCache: ${leadCache.length} leads`);

  let total = 0;
  const from = new Date(`${fromISO}T00:00:00Z`);
  const to = new Date(`${toISO}T23:59:59Z`);
  for (let start = new Date(from); start < to; ) {
    const end = new Date(Math.min(start.getTime() + chunkDays * 86_400_000, to.getTime()));
    const label = `${start.toISOString().slice(0, 10)}..${end.toISOString().slice(0, 10)}`;
    try {
      const n = await syncStatusChanges(start, end, leadCache, lookups);
      total += n;
      console.log(`[backfill-status-changes] ${label}: upserted ${n} (total ${total})`);
    } catch (err) {
      // Log and continue — a failed chunk can be re-run; upsert is idempotent.
      console.error(`[backfill-status-changes] ${label} FAILED:`, err instanceof Error ? err.message : err);
    }
    start = end;
  }
  console.log(`[backfill-status-changes] done, total upserted: ${total}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
