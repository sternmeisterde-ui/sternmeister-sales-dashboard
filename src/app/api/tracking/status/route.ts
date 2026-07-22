// Ручные статусы менеджеров для Активности (b2g): обед / встреча / завершил
// день. Менеджер управляет ТОЛЬКО своим текущим статусом («в моменте»);
// админ может добавлять/удалять интервалы задним числом (решение 2026-07-22).
//
// GET  /api/tracking/status?department=b2g
//   → { role, self: {managerId, name} | null, active: interval | null }
// POST /api/tracking/status  body:
//   { action: "start", department, status }            — менеджер, себе, с этого момента
//   { action: "stop", department }                      — менеджер, закрыть активный
//   { action: "add", department, managerId, status, from, to } — админ, задним числом (ISO)
//   { action: "delete", department, id }                — админ
import { NextRequest, NextResponse } from "next/server";
import { and, eq, isNull, desc, gte } from "drizzle-orm";
import { db as d1Db } from "@/lib/db";
import { masterManagers } from "@/lib/db/schema-existing";
import { trackingDb } from "@/lib/db/tracking-db";
import { managerStatusIntervals } from "@/lib/db/schema-tracking";
import { ensureTrackingSchema } from "@/lib/tracking/init";
import { tzOffsetMinutes } from "@/lib/utils/date";
import { getSession } from "@/lib/auth";

// Время из формы админа приходит наивной строкой "YYYY-MM-DDTHH:MM" и
// означает БЕРЛИНСКОЕ настенное время; строки с явной зоной берём как есть.
function parseWhen(s?: string): Date | null {
  if (!s) return null;
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) {
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(s)) return null;
  const guess = new Date(`${s.length === 16 ? `${s}:00` : s}Z`);
  if (isNaN(guess.getTime())) return null;
  return new Date(guess.getTime() - tzOffsetMinutes(guess, "Europe/Berlin") * 60_000);
}

export const dynamic = "force-dynamic";

const STATUSES = new Set(["lunch", "meeting", "day_end"]);

type Session = NonNullable<Awaited<ReturnType<typeof getSession>>>;

// Resolve the session to its master_managers row (b2g manager). Same matching
// chain as /api/tracking's ownTimelineOnly: telegram username → kommo user id
// → exact name.
async function resolveSelf(
  session: Session,
  department: string,
): Promise<{ managerId: string; name: string } | null> {
  if (session.role !== "manager") return null;
  if (session.department !== department) return null;
  const roster = await d1Db
    .select({
      id: masterManagers.id,
      name: masterManagers.name,
      telegramUsername: masterManagers.telegramUsername,
      kommoUserId: masterManagers.kommoUserId,
    })
    .from(masterManagers)
    .where(and(eq(masterManagers.department, department), eq(masterManagers.isActive, true)));
  const tgSession = session.telegramUsername?.toLowerCase() || null;
  const row = roster.find((m) => {
    const tgMaster = m.telegramUsername?.replace(/^@/, "").toLowerCase() || null;
    if (tgSession && tgMaster) return tgMaster === tgSession;
    if (session.kommoUserId && m.kommoUserId) return m.kommoUserId === session.kommoUserId;
    return m.name === session.name;
  });
  return row ? { managerId: row.id, name: row.name } : null;
}

async function findActive(department: string, managerId: string) {
  // «Активный» = незакрытый интервал за последние 2 суток (защита от вечно
  // висящих старых записей). day_end тоже возвращаем — менеджер может
  // «Вернуться к работе» и тем самым закрыть его.
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 3600_000);
  const [row] = await trackingDb
    .select()
    .from(managerStatusIntervals)
    .where(
      and(
        eq(managerStatusIntervals.department, department),
        eq(managerStatusIntervals.managerId, managerId),
        isNull(managerStatusIntervals.endedAt),
        gte(managerStatusIntervals.startedAt, twoDaysAgo),
      ),
    )
    .orderBy(desc(managerStatusIntervals.startedAt))
    .limit(1);
  return row ?? null;
}

async function closeActive(department: string, managerId: string): Promise<void> {
  const active = await findActive(department, managerId);
  if (active) {
    await trackingDb
      .update(managerStatusIntervals)
      .set({ endedAt: new Date() })
      .where(eq(managerStatusIntervals.id, active.id));
  }
}

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const department = url.searchParams.get("department");
    if (department !== "b2g") {
      // Статусы — фича Госников; для b2b отвечаем «нет плашки».
      return NextResponse.json({ role: null, self: null, active: null });
    }
    const session = await getSession();
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    await ensureTrackingSchema();
    const self = await resolveSelf(session, department);
    const active = self ? await findActive(department, self.managerId) : null;
    return NextResponse.json({ role: session.role, self, active });
  } catch (err) {
    console.error("[tracking/status] GET failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal error" },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      action?: string;
      department?: string;
      status?: string;
      managerId?: string;
      from?: string;
      to?: string;
      id?: number;
    };
    const department = body.department;
    if (department !== "b2g") {
      return NextResponse.json({ error: "Invalid department" }, { status: 400 });
    }
    const session = await getSession();
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    await ensureTrackingSchema();

    if (body.action === "start" || body.action === "stop") {
      const self = await resolveSelf(session, department);
      if (!self) {
        return NextResponse.json({ error: "Не нашли менеджера для этой сессии" }, { status: 403 });
      }
      if (body.action === "start") {
        if (!body.status || !STATUSES.has(body.status)) {
          return NextResponse.json({ error: "Invalid status" }, { status: 400 });
        }
        // Один активный статус за раз — предыдущий закрывается этим же кликом.
        await closeActive(department, self.managerId);
        await trackingDb.insert(managerStatusIntervals).values({
          department,
          managerId: self.managerId,
          status: body.status,
          startedAt: new Date(),
          createdBy: "self",
        });
      } else {
        await closeActive(department, self.managerId);
      }
      const active = await findActive(department, self.managerId);
      return NextResponse.json({ ok: true, active });
    }

    // Ретро-операции — только админ.
    if (session.role !== "admin") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    if (body.action === "add") {
      const from = parseWhen(body.from);
      const to = parseWhen(body.to);
      if (
        !body.managerId || !body.status || !STATUSES.has(body.status) ||
        !from || !to || to <= from
      ) {
        return NextResponse.json({ error: "Invalid add payload" }, { status: 400 });
      }
      await trackingDb.insert(managerStatusIntervals).values({
        department,
        managerId: body.managerId,
        status: body.status,
        startedAt: from,
        endedAt: to,
        createdBy: `admin:${session.name ?? "?"}`,
      });
      return NextResponse.json({ ok: true });
    }
    if (body.action === "delete") {
      if (!body.id || typeof body.id !== "number") {
        return NextResponse.json({ error: "Invalid id" }, { status: 400 });
      }
      await trackingDb
        .delete(managerStatusIntervals)
        .where(
          and(
            eq(managerStatusIntervals.id, body.id),
            eq(managerStatusIntervals.department, department),
          ),
        );
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (err) {
    console.error("[tracking/status] POST failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal error" },
      { status: 500 },
    );
  }
}
