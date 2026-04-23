// GET /api/daily/managers?department=b2g
// Returns all active managers for the department, read live from d1_users/r1_users.
// Used by SchedulePopup so the list is independent of cached daily snapshots.
import { NextRequest, NextResponse } from "next/server";
import { getManagersWithKommo } from "@/lib/db/queries-daily";

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const department = url.searchParams.get("department") || "b2g";

    const rows = await getManagersWithKommo(department);

    return NextResponse.json({
      department,
      managers: rows
        .filter((m) => m.role === "manager" || m.role === "rop")
        .map((m) => ({
          id: m.id,
          name: m.name,
          line: m.line,
        })),
    });
  } catch (error) {
    console.error("Daily managers GET error:", error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
