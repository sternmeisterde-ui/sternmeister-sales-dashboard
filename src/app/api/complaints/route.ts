// GET /api/complaints — список жалоб для вкладки «Жалобы».
// Доступ: admin — весь отдел из query; менеджер — ТОЛЬКО свои жалобы своего
// отдела (фильтр по менеджерам игнорируется, not_complaint скрыт). Ответ —
// лёгкие строки без jsonb-снимков (детализация — /api/complaints/[id]/eval).
// Свежесть: stale-while-revalidate — отдаём из реестра сразу, догоняющий синк
// источников (evaluation_error_reports + bug_reports) уходит в фон.

import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, gte, inArray, lt, or, sql, type SQL } from "drizzle-orm";
import { getSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { complaints } from "@/lib/db/schema-existing";
import {
  getManagersForDept,
  matchMasterManager,
  maybeSyncComplaintsInBackground,
} from "@/lib/complaints/ingest";
import { berlinCivilDate, addDaysCivil } from "@/lib/utils/date";
import type { Department } from "@/lib/eval/snapshot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const VALID_STATUSES = new Set(["new", "resolved", "rejected"]);

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const sp = req.nextUrl.searchParams;
  const department: Department = sp.get("department") === "b2b" ? "b2b" : "b2g";

  // Менеджер заперт в своём отделе (паттерн /api/scripts).
  if (session.role !== "admin" && department !== session.department) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const from = sp.get("from");
  const to = sp.get("to");
  if ((from && !DATE_RE.test(from)) || (to && !DATE_RE.test(to))) {
    return NextResponse.json({ error: "bad range" }, { status: 400 });
  }

  // Догоняющий синк источников — фоном, ответ не ждёт (троттлинг внутри).
  maybeSyncComplaintsInBackground();

  try {
    const isAdmin = session.role === "admin";
    const conds: SQL[] = [eq(complaints.department, department)];

    // Границы дат — берлинские сутки, to включительно (эксклюзивная верхняя
    // граница = следующий civil-день).
    if (from) conds.push(gte(complaints.filedAt, berlinCivilDate(from)));
    if (to) conds.push(lt(complaints.filedAt, berlinCivilDate(addDaysCivil(to, 1))));

    const statusFilter = (sp.get("status") || "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => VALID_STATUSES.has(s));

    const managers = await getManagersForDept(department);

    if (isAdmin) {
      if (statusFilter.length) {
        conds.push(inArray(complaints.status, statusFilter));
      }
      // Мультиселект менеджеров (CSV master_managers.id) — только у админа.
      const managerIds = (sp.get("managers") || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (managerIds.length) {
        conds.push(inArray(complaints.masterManagerId, managerIds));
      }
    } else {
      // Менеджер: принудительно «только своё». Владение — resolved master-id
      // ЛИБО telegram/имя на самой строке (страховка от несмэтченных строк).
      const caller = matchMasterManager(managers, {
        telegram: session.telegramUsername,
        name: session.name,
      });
      const tg = (session.telegramUsername || "").replace(/^@/, "").toLowerCase();
      const own: SQL[] = [];
      if (caller) own.push(eq(complaints.masterManagerId, caller.id));
      if (tg) {
        own.push(
          sql`lower(replace(coalesce(${complaints.managerTelegram}, ''), '@', '')) = ${tg}`,
        );
      }
      own.push(eq(complaints.managerName, session.name));
      conds.push(or(...own)!);
      if (statusFilter.length) {
        conds.push(inArray(complaints.status, statusFilter));
      }
    }

    const rows = await db
      .select({
        id: complaints.id,
        source: complaints.source,
        department: complaints.department,
        managerName: complaints.managerName,
        masterManagerId: complaints.masterManagerId,
        callId: complaints.callId,
        callSource: complaints.callSource,
        text: complaints.text,
        filedAt: complaints.filedAt,
        scoreBefore: complaints.scoreBefore,
        hasEvalBefore: sql<boolean>`(${complaints.evalBefore} IS NOT NULL)`,
        status: complaints.status,
        verdict: complaints.verdict,
        decision: complaints.decision,
        comment: complaints.comment,
        resolvedAt: complaints.resolvedAt,
        resolvedBy: complaints.resolvedBy,
        scoreAfter: complaints.scoreAfter,
        hasEvalAfter: sql<boolean>`(${complaints.evalAfter} IS NOT NULL)`,
      })
      .from(complaints)
      .where(and(...conds))
      .orderBy(desc(complaints.filedAt))
      .limit(1000);

    // Линия менеджера (b2g: 1=Квалификатор / 2=Бератеры / 3=Доведение) — для
    // фильтра направлений во вкладке. Берём текущую линию из master_managers
    // по resolved master_manager_id; не смэтчили → null (видна только в «Все»).
    const lineById = new Map(managers.map((m) => [m.id, m.line]));
    const withLine = rows.map((r) => ({
      ...r,
      managerLine: (r.masterManagerId && lineById.get(r.masterManagerId)) || null,
    }));

    return NextResponse.json(
      {
        complaints: withLine,
        // Для дропдауна фильтра у админа; менеджеру список не нужен.
        // Тот же предикат «звонящих», что в /api/daily/managers (вкладка
        // Звонки): активные manager/teamlead + РОПы с линией (двойной
        // статус). Админы, продления и «чистые» РОПы — не в списке.
        // Матчинг владения жалоб выше идёт по ПОЛНОМУ списку отдела.
        allManagers: isAdmin
          ? managers
              .filter(
                (m) =>
                  m.isActive !== false &&
                  (m.role === "manager" ||
                    m.role === "teamlead" ||
                    (m.role === "rop" && m.line != null)),
              )
              .sort((a, b) => a.name.localeCompare(b.name, "ru"))
              .map((m) => ({ id: m.id, name: m.name, line: m.line }))
          : [],
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    console.error("[/api/complaints] failed:", e);
    return NextResponse.json(
      { error: "internal", message: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
