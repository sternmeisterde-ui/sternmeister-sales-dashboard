import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema-existing";

type DrizzleDb = ReturnType<typeof drizzle>;

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
    const url = process.env.R1_DATABASE_URL;
    if (!url) {
      // Fallback: если R1_DATABASE_URL не задан, используем DATABASE_URL
      // (для обратной совместимости, когда все таблицы на одной ветке)
      console.warn("R1_DATABASE_URL not set, falling back to DATABASE_URL");
      return getD1Db();
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
