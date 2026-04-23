// GET  /api/daily/managers?department=b2g
// PATCH /api/daily/managers  body: { id: string, shiftStartTime?: string|null, shiftEndTime?: string|null }
// Returns active managers + "working ROPs" (role=rop with a line assigned) from
// master_managers for the given department. A ROP with line='2' is a double-status
// user — counted both as a ROP (access control) and as a line-2 team member
// (schedule, call metrics). ROPs without a line are pure managers-of-managers
// and stay out of the schedule popup.
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { masterManagers } from "@/lib/db/schema-existing";
import { and, eq, or, sql } from "drizzle-orm";

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
  try {
    const body = (await req.json()) as {
      id?: string;
      shiftStartTime?: string | null;
      shiftEndTime?: string | null;
    };
    if (!body.id) {
      return NextResponse.json({ error: "Missing id" }, { status: 400 });
    }

    const patch: { shiftStartTime?: string | null; shiftEndTime?: string | null; updatedAt: Date } = {
      updatedAt: new Date(),
    };
    if (body.shiftStartTime !== undefined) patch.shiftStartTime = body.shiftStartTime?.trim() || null;
    if (body.shiftEndTime !== undefined) patch.shiftEndTime = body.shiftEndTime?.trim() || null;

    await db.update(masterManagers).set(patch).where(eq(masterManagers.id, body.id));

    return NextResponse.json({ ok: true, id: body.id });
  } catch (error) {
    console.error("Daily managers PATCH error:", error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
