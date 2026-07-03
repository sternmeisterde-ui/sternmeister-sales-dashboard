// Exclude / restore a single call from the «Оценка критериев» stats.
//
// POST { department, source, callId, excluded, managerName?, callDate?, score? }
//   excluded=true  → upsert a row (call disappears from the tree + stops
//                    counting in /api/analytics aggregation).
//   excluded=false → delete the row (call comes back).
// GET ?department=&source=  → list current exclusions for the management panel.
//
// Moderation only: masterRole ∈ {admin, rop}. Plain managers and teamleads can
// see the tab but not exclude.

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { analyticsExcludedCalls } from "@/lib/db/schema-existing";
import { and, eq, desc } from "drizzle-orm";

// Решение 2026-07-03: teamlead намеренно НЕ модератор — исключать звонки
// из статистики могут только админ и ропы (доступ к вкладкам у тимлида
// остаётся, см. gateFromMasterRole).
const MODERATOR_ROLES = new Set(["admin", "rop"]);

function normDept(v: string | null): "b2g" | "b2b" | null {
  return v === "b2g" || v === "b2b" ? v : null;
}
function normSource(v: string | null): "okk" | "roleplay" | null {
  return v === "okk" || v === "roleplay" ? v : null;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const session = await getSession();
  if (!session || !MODERATOR_ROLES.has(session.masterRole)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const sp = request.nextUrl.searchParams;
  const department = normDept(sp.get("department"));
  const source = normSource(sp.get("source"));
  if (!department || !source) {
    return NextResponse.json({ error: "Invalid department/source" }, { status: 400 });
  }
  const rows = await db
    .select()
    .from(analyticsExcludedCalls)
    .where(and(eq(analyticsExcludedCalls.department, department), eq(analyticsExcludedCalls.source, source)))
    .orderBy(desc(analyticsExcludedCalls.createdAt));
  return NextResponse.json({ excluded: rows });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const session = await getSession();
  if (!session || !MODERATOR_ROLES.has(session.masterRole)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const department = normDept(typeof body.department === "string" ? body.department : null);
  const source = normSource(typeof body.source === "string" ? body.source : null);
  const callId = typeof body.callId === "string" ? body.callId.trim() : "";
  const excluded = body.excluded === true;
  if (!department || !source || !callId) {
    return NextResponse.json({ error: "Invalid department/source/callId" }, { status: 400 });
  }

  if (excluded) {
    const managerName = typeof body.managerName === "string" ? body.managerName : null;
    const callDate = typeof body.callDate === "string" ? body.callDate : null;
    const score = typeof body.score === "number" ? Math.round(body.score) : null;
    await db
      .insert(analyticsExcludedCalls)
      .values({
        department,
        source,
        callId,
        managerName,
        callDate,
        score,
        excludedById: session.userId ?? null,
        excludedByName: session.name ?? null,
      })
      .onConflictDoNothing({
        target: [
          analyticsExcludedCalls.department,
          analyticsExcludedCalls.source,
          analyticsExcludedCalls.callId,
        ],
      });
  } else {
    await db
      .delete(analyticsExcludedCalls)
      .where(
        and(
          eq(analyticsExcludedCalls.department, department),
          eq(analyticsExcludedCalls.source, source),
          eq(analyticsExcludedCalls.callId, callId),
        ),
      );
  }

  return NextResponse.json({ ok: true, excluded });
}
