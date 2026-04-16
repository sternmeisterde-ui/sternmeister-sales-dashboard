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
      .select({ filename: callAnalysisFiles.filename, content: callAnalysisFiles.content })
      .from(callAnalysisFiles)
      .where(eq(callAnalysisFiles.analysisId, id));

    if (files.length === 0) {
      return NextResponse.json({ error: "No files" }, { status: 404 });
    }

    // Build a simple ZIP using raw deflate-store (no compression, pure JS)
    // For simplicity, create a tar-like concatenation in a single .md file
    // OR use proper ZIP — let's do a proper one with the fflate library if available
    // Fallback: return all files as a single combined markdown
    let combined = "";
    for (const f of files) {
      combined += `\n\n${"=".repeat(80)}\n# ${f.filename}\n${"=".repeat(80)}\n\n${f.content}\n`;
    }

    const encoder = new TextEncoder();
    const bytes = encoder.encode(combined);

    const modeLabel = analysis.mode === "success" ? "success" : "failure";
    const filename = `analysis_${analysis.department}_${modeLabel}_${analysis.id.substring(0, 8)}.md`;

    return new NextResponse(bytes, {
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Length": String(bytes.length),
      },
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
