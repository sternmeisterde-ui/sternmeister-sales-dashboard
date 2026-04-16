import { NextRequest, NextResponse } from "next/server";
import { getDbForDepartment } from "@/lib/db";
import { callAnalyses, callAnalysisFiles } from "@/lib/db/schema-existing";
import { eq } from "drizzle-orm";
import { getSession } from "@/lib/auth";

export async function GET(
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

    const [analysis] = await db
      .select()
      .from(callAnalyses)
      .where(eq(callAnalyses.id, id));

    if (!analysis) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const files = await db
      .select({
        id: callAnalysisFiles.id,
        filename: callAnalysisFiles.filename,
        fileType: callAnalysisFiles.fileType,
        leadId: callAnalysisFiles.leadId,
        createdAt: callAnalysisFiles.createdAt,
      })
      .from(callAnalysisFiles)
      .where(eq(callAnalysisFiles.analysisId, id));

    return NextResponse.json({ success: true, data: { ...analysis, files } });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
