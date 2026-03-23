// POST /api/error-report — save manager error report + notify Discord
import { NextRequest, NextResponse } from "next/server";
import { getDailyDb } from "@/lib/db/daily-db";
import { sql } from "drizzle-orm";

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "https://discord.com/api/webhooks/1485520090110759053/Wg9K6VhRz4dgAxiKYk7RawfRrLQ886EckHeX8mKz5E2woPyOZUl8t2L5GZxd0uy6D7TQ";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { callId, department, source, managerName, managerTelegram, callDate, callScore, message } = body;

    if (!callId || !message?.trim()) {
      return NextResponse.json({ error: "callId and message required" }, { status: 400 });
    }

    // Save to DB
    const db = getDailyDb();
    await db.execute(sql`
      INSERT INTO evaluation_error_reports (call_id, department, source, manager_name, manager_telegram, call_date, call_score, message)
      VALUES (${callId}, ${department || "unknown"}, ${source || "okk"}, ${managerName || null}, ${managerTelegram || null}, ${callDate || null}, ${callScore || null}, ${message.trim()})
    `);

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
