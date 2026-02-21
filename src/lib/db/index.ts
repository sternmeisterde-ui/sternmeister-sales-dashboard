import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema-existing";

// Ленивое подключение к базе D1_roleplay (создается только при первом обращении)
let dbInstance: ReturnType<typeof drizzle> | null = null;

export function getDb() {
  if (!dbInstance) {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error("DATABASE_URL environment variable is not set");
    }
    const sql = neon(databaseUrl);
    dbInstance = drizzle(sql, { schema });
  }
  return dbInstance;
}

// Для обратной совместимости экспортируем db через getter
export const db = new Proxy({} as ReturnType<typeof drizzle>, {
  get(_target, prop) {
    return getDb()[prop as keyof ReturnType<typeof drizzle>];
  }
});

// Экспорт схемы для использования в других частях приложения
export { schema };
