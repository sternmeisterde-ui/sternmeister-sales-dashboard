// GET  /api/daily/managers?department=b2g
// PATCH /api/daily/managers  body: { id: string, shiftStartTime?: string|null, shiftEndTime?: string|null, dailyRate?: string|number|null }
// Returns active managers + "working ROPs" (role=rop with a line assigned) from
// master_managers for the given department. A ROP with line='2' is a double-status
// user — counted both as a ROP (access control) and as a line-2 team member
// (schedule, call metrics). ROPs without a line are pure managers-of-managers
// and stay out of the schedule popup.
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { masterManagers } from "@/lib/db/schema-existing";
import { and, eq, or, sql } from "drizzle-orm";
import { getSession } from "@/lib/auth";

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const department = url.searchParams.get("department") === "b2b" ? "b2b" : "b2g";

    const rows = await db
      .select({
        id: masterManagers.id,
        name: masterManagers.name,
        line: masterManagers.line,
        shiftStartTime: masterManagers.shiftStartTime,
        shiftEndTime: masterManagers.shiftEndTime,
      })
      .from(masterManagers)
      .where(
        and(
          eq(masterManagers.department, department),
          eq(masterManagers.isActive, true),
          or(
            eq(masterManagers.role, "manager"),
            eq(masterManagers.role, "teamlead"),
            and(eq(masterManagers.role, "rop"), sql`${masterManagers.line} IS NOT NULL`),
          ),
        ),
      )
      .orderBy(masterManagers.name);

    return NextResponse.json({ department, managers: rows });
  } catch (error) {
    console.error("Daily managers GET error:", error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  // Admin-only: this endpoint writes payroll-sensitive fields (dailyRate)
  // alongside per-day shift overrides. Without this gate any unauthenticated
  // caller could rewrite a manager's daily rate.
  const session = await getSession();
  if (!session || session.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const body = (await req.json()) as {
      id?: string;
      shiftStartTime?: string | null;
      shiftEndTime?: string | null;
      dailyRate?: string | number | null;
    };
    if (!body.id) {
      return NextResponse.json({ error: "Missing id" }, { status: 400 });
    }

    const patch: {
      shiftStartTime?: string | null;
      shiftEndTime?: string | null;
      dailyRate?: string | null;
      updatedAt: Date;
    } = { updatedAt: new Date() };

    if (body.shiftStartTime !== undefined) patch.shiftStartTime = body.shiftStartTime?.trim() || null;
    if (body.shiftEndTime !== undefined) patch.shiftEndTime = body.shiftEndTime?.trim() || null;
    if (body.dailyRate !== undefined) {
      // null / "" / 0 → clear (treat zero rate as "не задано" semantically; the
      // calculator anyway multiplies by 0 in that case so this is consistent).
      // Otherwise accept any positive number/string and store as 2-decimal text.
      if (body.dailyRate === null || body.dailyRate === "") {
        patch.dailyRate = null;
      } else {
        const n = typeof body.dailyRate === "number" ? body.dailyRate : Number.parseFloat(String(body.dailyRate));
        if (!Number.isFinite(n) || n < 0) {
          return NextResponse.json({ error: "Invalid dailyRate" }, { status: 400 });
        }
        patch.dailyRate = n.toFixed(2);
      }
    }

    await db.update(masterManagers).set(patch).where(eq(masterManagers.id, body.id));

    return NextResponse.json({ ok: true, id: body.id });
  } catch (error) {
    console.error("Daily managers PATCH error:", error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
