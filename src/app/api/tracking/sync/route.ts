// POST /api/tracking/sync?department=b2g&force=1
// Triggers an explicit Kommo → cache sync for one department.
// Useful for manual refresh button and for a future scheduled cron.
import { NextRequest, NextResponse } from "next/server";
import { syncDepartment } from "@/lib/tracking/sync";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const department = url.searchParams.get("department");
    const force = url.searchParams.get("force") === "1";
    if (department !== "b2g" && department !== "b2b") {
      return NextResponse.json({ error: "Invalid department" }, { status: 400 });
    }
    const res = await syncDepartment(department, { force });
    return NextResponse.json(res);
  } catch (err) {
    console.error("[tracking/sync] error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

export const GET = POST;
