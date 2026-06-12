import { NextRequest, NextResponse } from "next/server";
import { getDbForDepartment } from "@/lib/db";
import { callAnalyses } from "@/lib/db/schema-existing";
import { sql } from "drizzle-orm";
import { getSession } from "@/lib/auth";

/**
 * POST /api/analysis/[id]/cancel
 *
 * Stops a queued or running analysis WITHOUT destroying its work — unlike
 * DELETE, all already-saved transcripts/files stay, and Resume can continue
 * the job later from its checkpoint.
 *
 * How a RUNNING pipeline notices: its 20s heartbeat is a conditional
 * `UPDATE ... WHERE status='processing' RETURNING id` — after this flip the
 * heartbeat gets zero rows back, sets the abort flag, and the worker pool
 * drains within one in-flight unit (≤30s typically). No extra signalling
 * channel needed. The claim query in worker.ts ignores 'cancelled' rows, so
 * the cron tick won't pick it back up.
 *
 * `status` is a plain text column (no CHECK constraint in the Drizzle
 * schema), so 'cancelled' needs no migration.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getSession();
    if (!session || session.role !== "admin") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { id } = await params;
    const db = getDbForDepartment("b2g");

    // Single atomic statement: only pending/processing rows are cancellable
    // (done/error/cancelled are terminal — nothing to stop).
    const cancelled = await db
      .update(callAnalyses)
      .set({
        status: "cancelled",
        errorMessage: "Отменено пользователем",
        updatedAt: sql`now()`,
      })
      .where(sql`${callAnalyses.id} = ${id} AND status IN ('pending', 'processing')`)
      .returning({ id: callAnalyses.id });

    if (cancelled.length === 0) {
      return NextResponse.json(
        { error: "Not found or not cancellable (only pending/processing)" },
        { status: 400 },
      );
    }

    return NextResponse.json({ success: true, id });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
