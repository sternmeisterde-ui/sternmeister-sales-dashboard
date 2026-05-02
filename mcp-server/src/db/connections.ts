/**
 * Read-only Drizzle connections to all 6 dashboard Neon databases.
 * MCP tools call into these via the Proxy lazy-init pattern, mirroring the
 * dashboard's own `src/lib/db/*` style (one Proxy per DB, init on first
 * access, env-driven URLs).
 *
 * Phase 1 SECURITY NOTE: production deploy MUST use dedicated Postgres
 * roles `mcp_readonly_*` (see MCP-IMPLEMENTATION-PLAN.md §3.3). The env
 * vars below should point at THOSE role's DSNs — NOT the dashboard's
 * write-capable creds. Until those roles are provisioned, the env vars
 * fall back to the dashboard's own URLs which means SELECT works but a
 * compromised tool COULD theoretically also INSERT — protected only by
 * the audit log + curated tool surface (no escape hatch in v1).
 */

import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";

// Mode-mismatch trap: dashboard root is CJS (no "type":"module" in
// package.json), so tsx wraps these .ts schema files as `module.exports = {…}`
// at runtime. From our ESM workspace, star-import yields just `{ default,
// 'module.exports' }`; named imports get nothing. The runtime-extractor
// below pulls the actual exports out of `.default` if present, falling back
// to the namespace itself for the case where root is later flipped to ESM.
import * as dashSchemaModule from "../../../src/lib/db/schema-existing.js";
import * as okkSchemaModule from "../../../src/lib/db/schema-okk.js";
import * as analyticsSchemaModule from "../../../src/lib/db/schema-analytics.js";
import * as trackingSchemaModule from "../../../src/lib/db/schema-tracking.js";

function unwrap<T>(mod: T): T {
  const anyMod = mod as { default?: T };
  return (anyMod.default ?? mod) as T;
}

const dashSchema = unwrap(dashSchemaModule);
const okkSchema = unwrap(okkSchemaModule);
const analyticsSchema = unwrap(analyticsSchemaModule);
const trackingSchema = unwrap(trackingSchemaModule);

type DashDb = ReturnType<typeof drizzle<typeof dashSchema>>;
type OkkDb = ReturnType<typeof drizzle<typeof okkSchema>>;
type AnalyticsDb = ReturnType<typeof drizzle<typeof analyticsSchema>>;
type TrackingDb = ReturnType<typeof drizzle<typeof trackingSchema>>;

// Endpoint constants for R1 auto-derivation — matches src/lib/db/index.ts.
const D1_ENDPOINT = "ep-withered-recipe-ai1ea97w-pooler";
const R1_ENDPOINT = "ep-shiny-recipe-aio8wyp2-pooler";

function envOrThrow(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`${key} is not set`);
  return v;
}

function deriveR1Url(d1Url: string): string {
  return d1Url.replace(D1_ENDPOINT, R1_ENDPOINT);
}

// ─── lazy init per DB ────────────────────────────────────────────────────────

let d1Instance: DashDb | null = null;
function initD1(): DashDb {
  if (!d1Instance) {
    const url = process.env.MCP_D1_RO_URL ?? envOrThrow("DATABASE_URL");
    d1Instance = drizzle(neon(url), { schema: dashSchema });
  }
  return d1Instance;
}

let r1Instance: DashDb | null = null;
function initR1(): DashDb {
  if (!r1Instance) {
    let url = process.env.MCP_R1_RO_URL ?? process.env.R1_DATABASE_URL;
    if (!url) {
      const d1Url = process.env.MCP_D1_RO_URL ?? process.env.DATABASE_URL;
      if (!d1Url || !d1Url.includes(D1_ENDPOINT)) {
        throw new Error("R1 URL not set and cannot be auto-derived from D1");
      }
      url = deriveR1Url(d1Url);
    }
    r1Instance = drizzle(neon(url), { schema: dashSchema });
  }
  return r1Instance;
}

let d2Instance: OkkDb | null = null;
function initD2(): OkkDb {
  if (!d2Instance) {
    const url = process.env.MCP_D2_RO_URL ?? envOrThrow("D2_OKK_DATABASE_URL");
    d2Instance = drizzle(neon(url), { schema: okkSchema });
  }
  return d2Instance;
}

let r2Instance: OkkDb | null = null;
function initR2(): OkkDb {
  if (!r2Instance) {
    const url = process.env.MCP_R2_RO_URL ?? envOrThrow("R2_OKK_DATABASE_URL");
    r2Instance = drizzle(neon(url), { schema: okkSchema });
  }
  return r2Instance;
}

let analyticsInstance: AnalyticsDb | null = null;
function initAnalytics(): AnalyticsDb {
  if (!analyticsInstance) {
    const url = process.env.MCP_ANALYTICS_RO_URL ?? envOrThrow("ANALYTICS_DATABASE_URL");
    analyticsInstance = drizzle(neon(url), { schema: analyticsSchema });
  }
  return analyticsInstance;
}

let trackingInstance: TrackingDb | null = null;
function initTracking(): TrackingDb {
  if (!trackingInstance) {
    const url = process.env.MCP_TRACKING_RO_URL ?? envOrThrow("TRACKING_DATABASE_URL");
    trackingInstance = drizzle(neon(url), { schema: trackingSchema });
  }
  return trackingInstance;
}

// ─── lazy proxies (matches src/lib/db pattern) ──────────────────────────────

export const d1 = new Proxy({} as DashDb, {
  get: (_t, p) => initD1()[p as keyof DashDb],
});
export const r1 = new Proxy({} as DashDb, {
  get: (_t, p) => initR1()[p as keyof DashDb],
});
export const d2 = new Proxy({} as OkkDb, {
  get: (_t, p) => initD2()[p as keyof OkkDb],
});
export const r2 = new Proxy({} as OkkDb, {
  get: (_t, p) => initR2()[p as keyof OkkDb],
});
export const analytics = new Proxy({} as AnalyticsDb, {
  get: (_t, p) => initAnalytics()[p as keyof AnalyticsDb],
});
export const tracking = new Proxy({} as TrackingDb, {
  get: (_t, p) => initTracking()[p as keyof TrackingDb],
});

/** Department-aware OKK selector. Mirrors getOkkDbForDepartment in dashboard. */
export function okkForDept(dept: "b2g" | "b2b"): OkkDb {
  return dept === "b2b" ? r2 : d2;
}

/** Department-aware roleplay selector. */
export function roleplayForDept(dept: "b2g" | "b2b"): DashDb {
  return dept === "b2b" ? r1 : d1;
}

export { dashSchema, okkSchema, analyticsSchema, trackingSchema };
