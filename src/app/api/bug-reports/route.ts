// POST /api/bug-reports — user-submitted bug reports from the "Сообщить об
// ошибке" popup. Reporter identity is taken from the session (never from the
// body) so submissions can't be spoofed. Each report is persisted to
// bug_reports and mirrored to a Discord channel via webhook.

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { bugReports } from "@/lib/db/schema-existing";

const DISCORD_WEBHOOK_URL = process.env.DISCORD_BUG_REPORT_WEBHOOK_URL;

const VALID_SECTIONS = new Set([
  "dashboard",
  "daily",
  "analytics",
  "tracking",
  "looker",
  "real_calls",
  "ai_calls",
  "managers",
  "call_analysis",
  "criteria",
  "scripts",
]);

const SECTION_LABELS: Record<string, string> = {
  dashboard: "Звонки",
  daily: "Дейли",
  analytics: "Аналитика",
  tracking: "Активность",
  looker: "Looker",
  real_calls: "ОКК",
  ai_calls: "AI Ролевки",
  managers: "Менеджеры",
  call_analysis: "Анализ",
  criteria: "Критерии",
  scripts: "Скрипты",
};

const DEPT_LABELS: Record<string, string> = {
  b2g: "Госники",
  b2b: "Коммерсы",
};

const ROLE_LABELS: Record<string, string> = {
  admin: "Админ",
  rop: "РОП",
  manager: "Менеджер",
};

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
    }

    const body = (await req.json()) as {
      section?: unknown;
      description?: unknown;
      reportDate?: unknown;
    };

    const section = typeof body.section === "string" ? body.section : "";
    const description = typeof body.description === "string" ? body.description.trim() : "";
    const reportDate = typeof body.reportDate === "string" ? body.reportDate : "";

    if (!VALID_SECTIONS.has(section)) {
      return NextResponse.json({ error: "Некорректный раздел" }, { status: 400 });
    }
    if (description.length < 5 || description.length > 4000) {
      return NextResponse.json(
        { error: "Опишите проблему (от 5 до 4000 символов)" },
        { status: 400 },
      );
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(reportDate)) {
      return NextResponse.json({ error: "Некорректная дата" }, { status: 400 });
    }

    // Persist first. If DB write fails, do not send to Discord.
    const reporterRole = session.masterRole; // "admin" | "rop" | "manager"
    const [saved] = await db
      .insert(bugReports)
      .values({
        reporterId: session.userId,
        reporterName: session.name,
        reporterRole,
        reporterDepartment: session.department,
        section,
        description,
        reportDate,
      })
      .returning({ id: bugReports.id, createdAt: bugReports.createdAt });

    // Discord notification — fire-and-forget; a webhook outage must not break
    // the UX since the row is already stored.
    if (DISCORD_WEBHOOK_URL) {
      const sectionLabel = SECTION_LABELS[section] ?? section;
      const deptLabel = DEPT_LABELS[session.department] ?? session.department;
      const roleLabel = ROLE_LABELS[reporterRole] ?? reporterRole;

      const embed = {
        title: "🐞 Обращение пользователя",
        color: 0x5865f2,
        fields: [
          { name: "Отдел", value: deptLabel, inline: true },
          { name: "Роль", value: roleLabel, inline: true },
          { name: "От", value: session.name, inline: true },
          { name: "Раздел", value: sectionLabel, inline: true },
          { name: "Дата", value: reportDate, inline: true },
          { name: "Telegram", value: session.telegramUsername ? `@${session.telegramUsername}` : "—", inline: true },
          { name: "Описание", value: description.substring(0, 1000) },
        ],
        timestamp: saved?.createdAt?.toISOString() ?? new Date().toISOString(),
        footer: { text: `Report ID: ${saved?.id ?? ""}` },
      };

      fetch(DISCORD_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ embeds: [embed] }),
      }).catch((e) => console.error("[bug-reports] Discord webhook failed:", e));
    } else {
      console.warn("[bug-reports] DISCORD_BUG_REPORT_WEBHOOK_URL is not set");
    }

    return NextResponse.json({ ok: true, id: saved?.id });
  } catch (error) {
    console.error("[bug-reports] POST failed:", error);
    return NextResponse.json({ error: "Не удалось сохранить обращение" }, { status: 500 });
  }
}
