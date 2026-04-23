import "@/lib/db/neon-setup";
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as trackingSchema from "./schema-tracking";

type TrackingDb = ReturnType<typeof drizzle>;

// ==================== Tracking DB (Kommo activity cache) ====================
// Separate Neon project — TRACKING_DATABASE_URL.
// Holds raw Kommo events so the Tracking tab can recompute timelines without
// hammering Kommo on every render.

let trackingDbInstance: TrackingDb | null = null;
let sqlInstance: ReturnType<typeof neon> | null = null;

function getTrackingDb(): TrackingDb {
  if (!trackingDbInstance) {
    const url = process.env.TRACKING_DATABASE_URL;
    if (!url) throw new Error("TRACKING_DATABASE_URL is not set");
    sqlInstance = neon(url);
    trackingDbInstance = drizzle(sqlInstance, { schema: trackingSchema });
  }
  return trackingDbInstance;
}

/** Raw sql tag for DDL / admin operations (migrations are run imperatively). */
export function getTrackingSql() {
  getTrackingDb(); // ensure init
  if (!sqlInstance) throw new Error("tracking sql not initialised");
  return sqlInstance;
}

/** Lazy Proxy — matches pattern in analytics.ts/okk.ts/index.ts. */
export const trackingDb = new Proxy({} as TrackingDb, {
  get(_target, prop) {
    return getTrackingDb()[prop as keyof TrackingDb];
  },
});

export { trackingSchema };
