import { NextRequest, NextResponse } from "next/server";
import { syncEnps } from "@/lib/enps/sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * GET /api/analytics/sync/enps — принудительный синк eNPS из Google Sheets.
 *
 * Живёт под /api/analytics/sync/* намеренно: этот префикс в whitelist
 * middleware (cookie-гейт не мешает крону). Защита — CRON_SECRET, как у
 * остальных sync-роутов. Lease-lock не нужен: синк маленький и идемпотентный
 * (upsert по token), параллельный прогон безвреден.
 *
 * Основной путь обновления — stale-while-revalidate в GET /api/enps;
 * этот endpoint — для крона/ручного прогона (например, после бэкфилла).
 */
export async function GET(req: NextRequest) {
  const secret = req.headers.get("x-cron-secret") ?? req.nextUrl.searchParams.get("secret");
  const expected = process.env.CRON_SECRET;
  if (!expected) return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
  if (!secret || secret !== expected) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await syncEnps();
  return NextResponse.json(result, { status: result.ok ? 200 : 502 });
}
