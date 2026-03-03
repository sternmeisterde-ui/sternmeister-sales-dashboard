import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema-existing";

type DrizzleDb = ReturnType<typeof drizzle>;

// Neon branch endpoints (same project, same credentials, same DB name)
// D1 = ep-withered-recipe-ai1ea97w (Госники / B2G) — main branch
// R1 = ep-shiny-recipe-aio8wyp2   (Коммерсы / B2B) — child branch
const R1_ENDPOINT = "ep-shiny-recipe-aio8wyp2-pooler";
const D1_ENDPOINT = "ep-withered-recipe-ai1ea97w-pooler";

function deriveR1Url(d1Url: string): string {
  return d1Url.replace(D1_ENDPOINT, R1_ENDPOINT);
}

// ==================== D1 (B2G / Госники) ====================
let d1DbInstance: DrizzleDb | null = null;

function getD1Db(): DrizzleDb {
  if (!d1DbInstance) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    d1DbInstance = drizzle(neon(url), { schema });
  }
  return d1DbInstance;
}

// ==================== R1 (B2B / Коммерсы) ====================
let r1DbInstance: DrizzleDb | null = null;

function getR1Db(): DrizzleDb {
  if (!r1DbInstance) {
    let url = process.env.R1_DATABASE_URL;
    if (!url) {
      // Auto-derive R1 URL from DATABASE_URL by swapping the Neon branch endpoint
      const d1Url = process.env.DATABASE_URL;
      if (d1Url && d1Url.includes(D1_ENDPOINT)) {
        url = deriveR1Url(d1Url);
        console.log("R1_DATABASE_URL auto-derived from DATABASE_URL");
      } else {
        console.warn("R1_DATABASE_URL not set and cannot derive from DATABASE_URL");
        return getD1Db();
      }
    }
    r1DbInstance = drizzle(neon(url), { schema });
  }
  return r1DbInstance;
}

// ==================== Выбор DB по отделу ====================

export function getDbForDepartment(department: string): DrizzleDb {
  return department === "b2b" ? getR1Db() : getD1Db();
}

// Обратная совместимость: db = D1 (основная ветка)
export const db = new Proxy({} as DrizzleDb, {
  get(_target, prop) {
    return getD1Db()[prop as keyof DrizzleDb];
  },
});

// R1 db
export const r1Db = new Proxy({} as DrizzleDb, {
  get(_target, prop) {
    return getR1Db()[prop as keyof DrizzleDb];
  },
});

export { schema };
