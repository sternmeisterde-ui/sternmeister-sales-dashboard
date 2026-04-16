import { NextRequest, NextResponse } from "next/server";
import { getDbForDepartment } from "@/lib/db";
import { callAnalyses } from "@/lib/db/schema-existing";
import { eq } from "drizzle-orm";
import { getSession } from "@/lib/auth";

/**
 * DELETE /api/analysis/[id]/delete
 * Kills a running/stuck analysis and deletes all associated files.
 * Files auto-cascade via ON DELETE CASCADE.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getSession();
    if (!session || session.role !== "admin") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { id } = await params;
    const db = getDbForDepartment("b2g");

    // Delete analysis + all files (CASCADE)
    const deleted = await db
      .delete(callAnalyses)
      .where(eq(callAnalyses.id, id))
      .returning({ id: callAnalyses.id });

    if (deleted.length === 0) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    return NextResponse.json({ success: true, deleted: id });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
