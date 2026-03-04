import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as okkSchema from "./schema-okk";

type OkkDb = ReturnType<typeof drizzle>;

// ==================== R2 (B2B / Коммерсы) ====================
// NOTE: department mapping is OPPOSITE to branch naming:
//   b2b  →  R2 branch  →  env R2_OKK_DATABASE_URL
//   b2g  →  D2 branch  →  env D2_OKK_DATABASE_URL

let r2OkkDbInstance: OkkDb | null = null;

function getR2OkkDb(): OkkDb {
  if (!r2OkkDbInstance) {
    const url = process.env.R2_OKK_DATABASE_URL;
    if (!url) {
      throw new Error(
        "R2_OKK_DATABASE_URL is not set. " +
        "Add it to your .env.local for B2B/Коммерсы OKK data."
      );
    }
    r2OkkDbInstance = drizzle(neon(url), { schema: okkSchema });
  }
  return r2OkkDbInstance;
}

// ==================== D2 (B2G / Госники) ====================

let d2OkkDbInstance: OkkDb | null = null;

function getD2OkkDb(): OkkDb {
  if (!d2OkkDbInstance) {
    const url = process.env.D2_OKK_DATABASE_URL;
    if (!url) {
      throw new Error(
        "D2_OKK_DATABASE_URL is not set. " +
        "Add it to your .env.local for B2G/Госники OKK data."
      );
    }
    d2OkkDbInstance = drizzle(neon(url), { schema: okkSchema });
  }
  return d2OkkDbInstance;
}

// ==================== Public API ====================

/**
 * Returns the OKK database for the given department.
 *   "b2b"  →  R2 branch (Коммерсы)
 *   "b2g"  →  D2 branch (Госники)
 */
export function getOkkDbForDepartment(department: "b2g" | "b2b"): OkkDb {
  return department === "b2b" ? getR2OkkDb() : getD2OkkDb();
}

/**
 * Lazy Proxy for R2 OKK db (B2B / Коммерсы).
 * Access triggers initialization on first use, same pattern as main index.ts.
 */
export const r2OkkDb = new Proxy({} as OkkDb, {
  get(_target, prop) {
    return getR2OkkDb()[prop as keyof OkkDb];
  },
});

/**
 * Lazy Proxy for D2 OKK db (B2G / Госники).
 */
export const d2OkkDb = new Proxy({} as OkkDb, {
  get(_target, prop) {
    return getD2OkkDb()[prop as keyof OkkDb];
  },
});

export { okkSchema };
