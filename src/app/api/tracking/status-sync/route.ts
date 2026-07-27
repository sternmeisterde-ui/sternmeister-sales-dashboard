// Тик поллера присутствия CloudTalk (спека 26, Фаза 0).
//
// GET|POST /api/tracking/status-sync
//   • крон (compose-сервис status-cron, раз в 60с) — заголовок x-cron-secret;
//   • админ-сессия — для ручной проверки из браузера.
//
// Тик дешёвый (2 запроса к CloudTalk + пара UPDATE) и должен отвечать за секунды.
// Ошибки возвращаем 500 с текстом, чтобы они были видны в логе крон-сервиса, но
// НЕ роняем ничего другого: без свежих данных дорожка деградирует до «нет
// данных», а не рисует выдуманное присутствие.
import { NextRequest, NextResponse } from "next/server";
import { syncCloudTalkStatuses } from "@/lib/tracking/cloudtalk-status-sync";
import { getSession } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const provided =
    req.headers.get("x-cron-secret") ??
    new URL(req.url).searchParams.get("secret");

  let authorized = Boolean(cronSecret && provided && provided === cronSecret);
  if (!authorized) {
    const session = await getSession();
    authorized = session?.role === "admin";
  }
  if (!authorized) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const started = Date.now();
    const result = await syncCloudTalkStatuses();
    return NextResponse.json({ ok: true, ms: Date.now() - started, ...result });
  } catch (err) {
    console.error("[cloudtalk-status] sync failed:", err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
