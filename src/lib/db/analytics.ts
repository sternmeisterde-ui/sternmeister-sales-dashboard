import "@/lib/db/neon-setup";
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as analyticsSchema from "./schema-analytics";

type AnalyticsDb = ReturnType<typeof drizzle>;

// ==================== Analytics DB (mirror of 3rd-party Looker feed) ====================
// Separate Neon project — used for cross-checking metrics against the integrator's
// MySQL (45.156.25.84/db) and eventually replacing that pipeline.

let analyticsDbInstance: AnalyticsDb | null = null;

function getAnalyticsDb(): AnalyticsDb {
  if (!analyticsDbInstance) {
    const url = process.env.ANALYTICS_DATABASE_URL;
    if (!url) throw new Error("ANALYTICS_DATABASE_URL is not set");
    analyticsDbInstance = drizzle(neon(url), { schema: analyticsSchema });
  }
  return analyticsDbInstance;
}

/** Lazy Proxy — initialises on first access, matches the pattern in okk.ts/index.ts */
export const analyticsDb = new Proxy({} as AnalyticsDb, {
  get(_target, prop) {
    return getAnalyticsDb()[prop as keyof AnalyticsDb];
  },
});

export { analyticsSchema };
