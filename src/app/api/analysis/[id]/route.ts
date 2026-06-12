import { NextRequest, NextResponse } from "next/server";
import { getDbForDepartment } from "@/lib/db";
import { callAnalyses, callAnalysisFiles } from "@/lib/db/schema-existing";
import { and, eq, ne } from "drizzle-orm";
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
      // 'manifest' = the pipeline's internal _manifest.json checkpoint —
      // never user-facing.
      .where(and(eq(callAnalysisFiles.analysisId, id), ne(callAnalysisFiles.fileType, "manifest")));

    return NextResponse.json({ success: true, data: { ...analysis, files } });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
