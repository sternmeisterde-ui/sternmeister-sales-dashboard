// POST /api/error-report — save manager error report + notify Discord
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDailyDb } from "@/lib/db/daily-db";
import { sql } from "drizzle-orm";
import { ingestErrorReport } from "@/lib/complaints/ingest";

// Env-only — no hardcoded fallback. If unset, the send below is skipped
// (the `if (DISCORD_WEBHOOK_URL)` guard); the report is still saved to the DB.
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

export async function POST(req: NextRequest) {
  try {
    // Форма живёт только внутри залогиненного дашборда — сессия обязательна.
    // Раньше роут принимал личность из тела запроса (spoofable); telegram
    // теперь всегда из сессии. managerName остаётся из тела: это менеджер
    // ЗВОНКА (субъект жалобы) — админ может жаловаться от имени менеджера.
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    const { callId, department, source, managerName, callDate, callScore, message } = body;
    const managerTelegram = session.telegramUsername || null;

    if (!callId || !message?.trim()) {
      return NextResponse.json({ error: "callId and message required" }, { status: 400 });
    }

    // Save to DB
    const db = getDailyDb();
    const inserted = await db.execute(sql`
      INSERT INTO evaluation_error_reports (call_id, department, source, manager_name, manager_telegram, call_date, call_score, message)
      VALUES (${callId}, ${department || "unknown"}, ${source || "okk"}, ${managerName || null}, ${managerTelegram || null}, ${callDate || null}, ${callScore || null}, ${message.trim()})
      RETURNING id, created_at
    `);

    // Dual-write в реестр жалоб (D1 complaints, вкладка «Жалобы»): здесь же
    // замораживается снимок оценки «до». Сбой НЕ роняет legacy-запись —
    // догоняющий синк (syncComplaints) дорегистрирует строку позже.
    try {
      const saved = inserted.rows?.[0] as { id: string | number; created_at: Date | string } | undefined;
      if (saved) {
        await ingestErrorReport({
          id: saved.id,
          call_id: callId,
          created_at: saved.created_at ?? new Date(),
          department: department || "unknown",
          source: source || "okk",
          manager_name: managerName || null,
          manager_telegram: managerTelegram,
          call_score: typeof callScore === "number" ? callScore : null,
          message: message.trim(),
        });
      }
    } catch (e) {
      console.error("[error-report] complaints ingest failed:", e);
    }

    // Send Discord notification
    if (DISCORD_WEBHOOK_URL) {
      const sourceLabel = source === "ai" ? "AI Ролевки" : "ОКК";
      const deptLabel = department === "b2b" ? "Коммерсы" : "Госники";

      const embed = {
        title: "⚠️ Жалоба на оценку звонка",
        color: 0xff6b6b,
        fields: [
          { name: "Отдел", value: deptLabel, inline: true },
          { name: "Источник", value: sourceLabel, inline: true },
          { name: "Менеджер", value: managerName || "—", inline: true },
          { name: "Telegram", value: managerTelegram ? `@${managerTelegram}` : "—", inline: true },
          { name: "Дата звонка", value: callDate || "—", inline: true },
          { name: "Оценка", value: callScore !== null ? `${callScore}%` : "—", inline: true },
          { name: "Сообщение", value: message.trim().substring(0, 1000) },
        ],
        timestamp: new Date().toISOString(),
        footer: { text: `Call ID: ${callId}` },
      };

      fetch(DISCORD_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ embeds: [embed] }),
      }).catch((e) => console.error("Discord webhook error:", e));
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Error report save failed:", error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
