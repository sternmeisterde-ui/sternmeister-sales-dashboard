// PUT /api/daily/plans — Upsert a single plan value
import { NextRequest, NextResponse } from "next/server";
import { upsertPlan } from "@/lib/db/queries-daily";

export async function PUT(req: NextRequest) {
  try {
    const body = await req.json();
    const { department, line, userId, metricKey, planValue, periodType, periodDate } = body;

    // Validate required fields
    if (!department || !line || !metricKey || planValue === undefined || !periodType || !periodDate) {
      return NextResponse.json(
        { error: "Missing required fields: department, line, metricKey, planValue, periodType, periodDate" },
        { status: 400 }
      );
    }

    await upsertPlan({
      department,
      line,
      userId: userId || null,
      metricKey,
      planValue: String(planValue),
      periodType,
      periodDate,
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Plan upsert error:", error);
    return NextResponse.json(
      { error: String(error) },
      { status: 500 }
    );
  }
}
