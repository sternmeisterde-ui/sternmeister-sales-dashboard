import { NextRequest, NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { getSession } from "@/lib/auth";
import { getDbForDepartment } from "@/lib/db/index";
import { getOkkDbForDepartment } from "@/lib/db/okk";
import { d1VoiceFeedback } from "@/lib/db/schema-existing";
import { okkVoiceFeedback } from "@/lib/db/schema-okk";

// Прокси проигрывания голосового «Разбора ОС» (работа над ошибками) — стримит
// файл из Telegram по voice_file_id. НЕ хранит файл на диске.
//   source=okk → реальные звонки b2g (D2 voice_feedback), бот OKK
//   source=ai  → AI Ролевки b2g (D1 d1_voice_feedback), бот D1 (ролевки)
// Токены: OKK_TELEGRAM_BOT_TOKEN / D1_TELEGRAM_BOT_TOKEN, с фолбэком на уже
// заведённые TELEGRAM_OKK_BOT_TOKEN / TELEGRAM_BOT_TOKEN (если бот тот же).
// b2g-only: обе таблицы — Госники; auth как у остальных /api/* + dept-гейт.

export const runtime = "nodejs";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ callId: string }> },
) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    // Фича — b2g. Не-b2g не-админам отказываем (b2b вкладку/кнопку не видит).
    if (session.role !== "admin" && session.department !== "b2g") {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const { callId } = await params;
    if (!UUID_RE.test(callId)) {
      return NextResponse.json({ error: "Invalid call ID" }, { status: 400 });
    }
    const source = request.nextUrl.searchParams.get("source") === "ai" ? "ai" : "okk";

    // voice_file_id (самый свежий разбор) + токен нужного бота.
    let fileId: string | null = null;
    let token: string | undefined;
    if (source === "ai") {
      token = process.env.D1_TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
      const db = getDbForDepartment("b2g");
      const [r] = await db
        .select({ v: d1VoiceFeedback.voiceFileId })
        .from(d1VoiceFeedback)
        .where(eq(d1VoiceFeedback.callId, callId))
        .orderBy(desc(d1VoiceFeedback.createdAt))
        .limit(1);
      fileId = r?.v ?? null;
    } else {
      token = process.env.OKK_TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_OKK_BOT_TOKEN;
      const db = getOkkDbForDepartment("b2g");
      const [r] = await db
        .select({ v: okkVoiceFeedback.voiceFileId })
        .from(okkVoiceFeedback)
        .where(eq(okkVoiceFeedback.callId, callId))
        .orderBy(desc(okkVoiceFeedback.createdAt))
        .limit(1);
      fileId = r?.v ?? null;
    }

    if (!token) {
      return NextResponse.json(
        { error: "Bot token not configured" },
        { status: 503 },
      );
    }
    if (!fileId) {
      return NextResponse.json(
        { error: "No voice feedback for this call" },
        { status: 404 },
      );
    }

    // 1) getFile → file_path
    const gfRes = await fetch(
      `https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`,
    );
    const gfJson = (await gfRes.json()) as {
      ok: boolean;
      result?: { file_path?: string };
    };
    const filePath = gfJson.result?.file_path;
    if (!gfJson.ok || !filePath) {
      return NextResponse.json(
        { error: "Voice file not available in Telegram" },
        { status: 404 },
      );
    }

    // 2) stream file (Telegram voice = OGG/Opus)
    const upstream = await fetch(
      `https://api.telegram.org/file/bot${token}/${filePath}`,
    );
    if (!upstream.ok || !upstream.body) {
      return NextResponse.json(
        { error: "Failed to fetch voice file" },
        { status: 502 },
      );
    }
    const contentType =
      upstream.headers.get("content-type") ||
      (filePath.endsWith(".oga") || filePath.endsWith(".ogg") ? "audio/ogg" : "audio/mpeg");
    const contentLength = upstream.headers.get("content-length");
    const headers: Record<string, string> = {
      "Content-Type": contentType,
      "Cache-Control": "private, max-age=3600",
      "Accept-Ranges": "bytes",
    };
    if (contentLength) headers["Content-Length"] = contentLength;
    return new NextResponse(upstream.body, { status: 200, headers });
  } catch (error) {
    console.error("[Voice feedback audio] proxy error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
