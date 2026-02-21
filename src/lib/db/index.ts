import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema-existing";

// Подключение к базе D1_roleplay (содержит таблицы для обоих отделов)
const sql = neon(process.env.DATABASE_URL!);
export const db = drizzle(sql, { schema });

// Экспорт схемы для использования в других частях приложения
export { schema };
