// GET /api/exports/process/tick
//
// Воркер выгрузки звонков контакта на Google Drive. Дёргается из etl-cron
// каждый тик (~10 мин). Берёт несколько pending-строк из
// analytics.contact_call_exports, собирает папку «{Имя} {дата оплаты}» из
// okk_calls (аудио + транскрипт) и заливает на Drive.
//
// Авторизация — CRON_SECRET (x-cron-secret header или ?secret=), как у sync-
// кронов. Lease-lock в analytics.etl_locks (name='export-cron') не даёт двум
// тикам пересечься. Сама обработка идемпотентна (ensureFolder/fileExists),
// поэтому пересечение всё равно безопасно — lock лишь экономит работу.

import { type NextRequest, NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { analyticsDb } from "@/lib/db/analytics";
import { withDbRetry } from "@/lib/db/with-retry";
import { processPendingExports } from "@/lib/exports/process-export";

export const maxDuration = 300;
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const LOCK_NAME = "export-cron";
const LEASE_MINUTES = 6; // > maxDuration(300s) + запас
const BATCH = 3; // сколько контактов обрабатываем за тик (медиа — тяжёлое)

async function tryAcquireLock(): Promise<string | null> {
  const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const res = await withDbRetry(
    () => analyticsDb.execute<{ token: string }>(sql`
      INSERT INTO analytics.etl_locks (name, token, acquired_at, expires_at)
      VALUES (${LOCK_NAME}, ${token}, now(), now() + ${`${LEASE_MINUTES} minutes`}::interval)
      ON CONFLICT (name) DO UPDATE
        SET token       = EXCLUDED.token,
            acquired_at = EXCLUDED.acquired_at,
            expires_at  = EXCLUDED.expires_at
        WHERE analytics.etl_locks.expires_at <= now()
      RETURNING token
    `),
    { label: "export-cron:acquire-lock" },
  );
  const row = res.rows[0];
  return row && row.token === token ? token : null;
}

async function releaseLock(token: string): Promise<void> {
  await withDbRetry(
    () => analyticsDb.execute(sql`
      UPDATE analytics.etl_locks
      SET token = '', expires_at = now(), last_completed_at = now()
      WHERE name = ${LOCK_NAME} AND token = ${token}
    `),
    { label: "export-cron:release-lock" },
  );
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const secret =
    req.headers.get("x-cron-secret") ?? req.nextUrl.searchParams.get("secret");
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
  }
  if (!secret || secret !== expected) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let token: string | null = null;
  try {
    token = await tryAcquireLock();
  } catch (lockErr) {
    console.error("[export-cron] lock acquire failed:", lockErr);
    return NextResponse.json(
      { success: false, skipped: true, reason: "lock query failed" },
      { status: 503 },
    );
  }
  if (!token) {
    return NextResponse.json(
      { success: false, skipped: true, reason: "concurrent run in progress" },
      { status: 409 },
    );
  }

  try {
    const result = await processPendingExports(BATCH);
    return NextResponse.json({ success: true, result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal error";
    console.error("[export-cron] failed:", error);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  } finally {
    try {
      await releaseLock(token);
    } catch (unlockErr) {
      console.warn("[export-cron] release lock failed (auto-expires):", unlockErr);
    }
  }
}
