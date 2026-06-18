// Миграция: добавляет call_analyses.updated_at (heartbeat для recovery
// застрявших processing-джоб). Idempotent — можно гонять повторно.
//
// ВАЖНО: применить на ПРОД D1 ДО деплоя кода (новый код читает updated_at).
// Если с этой машины D1 недоступен — выполни SQL вручную в Neon SQL Editor:
//   ALTER TABLE call_analyses ADD COLUMN IF NOT EXISTS updated_at timestamptz;
//
//   npx tsx scripts/apply-migration-call-analyses-updated-at.ts

import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { sql } from "drizzle-orm";
import { getDbForDepartment } from "../src/lib/db";

async function main(): Promise<void> {
  const db = getDbForDepartment("b2g"); // D1 (main DB)
  await db.execute(
    sql`ALTER TABLE call_analyses ADD COLUMN IF NOT EXISTS updated_at timestamptz`,
  );
  console.log("✓ call_analyses.updated_at добавлена (или уже была).");
}

main().then(() => process.exit(0)).catch((e) => { console.error("fatal:", e instanceof Error ? e.message : e); process.exit(1); });
