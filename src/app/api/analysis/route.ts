import { NextRequest, NextResponse } from "next/server";
import { getDbForDepartment } from "@/lib/db";
import { callAnalyses } from "@/lib/db/schema-existing";
import { eq, desc } from "drizzle-orm";
import { runAnalysisPipeline } from "@/lib/analysis/pipeline";
import { getSession } from "@/lib/auth";

// POST — create new analysis
export async function POST(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session || session.role !== "admin") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = await request.json();
    const { department, kommoUrl, mode } = body;

    if (!department || !kommoUrl || !mode) {
      return NextResponse.json({ error: "Missing fields" }, { status: 400 });
    }
    if (!["b2g", "b2b"].includes(department)) {
      return NextResponse.json({ error: "Invalid department" }, { status: 400 });
    }
    if (!["success", "failure"].includes(mode)) {
      return NextResponse.json({ error: "mode must be success or failure" }, { status: 400 });
    }
    // Validate Kommo URL domain
    try {
      const parsed = new URL(kommoUrl);
      if (parsed.hostname !== "sternmeister.kommo.com") {
        return NextResponse.json({ error: "Invalid Kommo URL" }, { status: 400 });
      }
    } catch {
      return NextResponse.json({ error: "Invalid URL" }, { status: 400 });
    }

    const db = getDbForDepartment("b2g");

    const [analysis] = await db
      .insert(callAnalyses)
      .values({
        department,
        kommoUrl,
        mode,
        status: "pending",
        createdBy: session.name,
      })
      .returning();

    // Don't run pipeline here — serverless function dies after response.
    // Frontend will call /api/analysis/process to start the long-running job.
    return NextResponse.json({ success: true, id: analysis.id });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// GET — list analyses
export async function GET(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session || session.role !== "admin") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    const sp = request.nextUrl.searchParams;
    const department = sp.get("department") || "b2g";

    const db = getDbForDepartment("b2g");

    const analyses = await db
      .select({
        id: callAnalyses.id,
        department: callAnalyses.department,
        kommoUrl: callAnalyses.kommoUrl,
        mode: callAnalyses.mode,
        status: callAnalyses.status,
        progress: callAnalyses.progress,
        totalCalls: callAnalyses.totalCalls,
        processedCalls: callAnalyses.processedCalls,
        createdBy: callAnalyses.createdBy,
        createdAt: callAnalyses.createdAt,
        expiresAt: callAnalyses.expiresAt,
        errorMessage: callAnalyses.errorMessage,
      })
      .from(callAnalyses)
      .where(eq(callAnalyses.department, department))
      .orderBy(desc(callAnalyses.createdAt))
      .limit(50);

    return NextResponse.json({ success: true, data: analyses });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
