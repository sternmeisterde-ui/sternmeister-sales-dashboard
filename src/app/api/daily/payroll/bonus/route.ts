// PATCH /api/daily/payroll/bonus
//   body: { userId: string, periodMonth: 'YYYY-MM', amount: number|string|null, note?: string|null }
//
// Upserts a manual monthly premium for the manager. amount = null / "" / 0
// deletes the row (kept tidy: a zero-row is the same as no row in our model).
// Admin-only — premium amounts are sensitive.

import { type NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { getSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { managerBonuses } from "@/lib/db/schema-existing";

export async function PATCH(req: NextRequest): Promise<NextResponse> {
  const session = await getSession();
  if (!session || session.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: { userId?: string; periodMonth?: string; amount?: number | string | null; note?: string | null };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const userId = body.userId;
  const periodMonth = body.periodMonth;
  if (!userId || !/^[0-9a-f-]{36}$/i.test(userId)) {
    return NextResponse.json({ error: "Invalid userId" }, { status: 400 });
  }
  if (!periodMonth || !/^\d{4}-(0[1-9]|1[0-2])$/.test(periodMonth)) {
    return NextResponse.json({ error: "Invalid periodMonth" }, { status: 400 });
  }

  // Resolve amount: null / "" / 0 = clear, otherwise a non-negative number.
  let amountNum: number | null = null;
  if (body.amount === null || body.amount === undefined || body.amount === "") {
    amountNum = null;
  } else {
    const n = typeof body.amount === "number" ? body.amount : Number.parseFloat(String(body.amount));
    if (!Number.isFinite(n) || n < 0) {
      return NextResponse.json({ error: "Invalid amount" }, { status: 400 });
    }
    amountNum = n === 0 ? null : n;
  }

  const note = body.note === undefined ? undefined : (body.note?.toString().trim() || null);

  try {
    if (amountNum === null) {
      await db
        .delete(managerBonuses)
        .where(and(eq(managerBonuses.userId, userId), eq(managerBonuses.periodMonth, periodMonth)));
      return NextResponse.json({ ok: true, cleared: true });
    }

    // Atomic upsert via the UNIQUE INDEX on (user_id, period_month). When the
    // caller omits `note`, we preserve the stored note; passing null clears it.
    const setOnUpdate: { amount: string; note?: string | null; updatedAt: Date } = {
      amount: amountNum.toFixed(2),
      updatedAt: new Date(),
    };
    if (note !== undefined) setOnUpdate.note = note;

    await db
      .insert(managerBonuses)
      .values({
        userId,
        periodMonth,
        amount: amountNum.toFixed(2),
        note: note ?? null,
      })
      .onConflictDoUpdate({
        target: [managerBonuses.userId, managerBonuses.periodMonth],
        set: setOnUpdate,
      });

    return NextResponse.json({ ok: true, amount: amountNum, note: note ?? null });
  } catch (err) {
    console.error("[bonus PATCH]", err);
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
