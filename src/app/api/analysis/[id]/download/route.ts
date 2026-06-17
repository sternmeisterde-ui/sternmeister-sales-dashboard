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
      .select({ filename: callAnalysisFiles.filename, content: callAnalysisFiles.content })
      .from(callAnalysisFiles)
      // 'manifest' = the pipeline's internal _manifest.json checkpoint —
      // never user-facing.
      .where(and(eq(callAnalysisFiles.analysisId, id), ne(callAnalysisFiles.fileType, "manifest")))
      // Сохраняем порядок звонков (call_01, call_02, …).
      .orderBy(callAnalysisFiles.filename);

    if (files.length === 0) {
      return NextResponse.json({ error: "No files" }, { status: 404 });
    }

    // Склейка звонков в один .md. Без технических заголовков с именем файла —
    // у каждого звонка уже своя шапка (Дата / Менеджер / Ссылка). Разделяем
    // горизонтальной линией, чтобы выгрузка читалась как лента переписок.
    const combined = files.map((f) => f.content.trim()).join("\n\n---\n\n") + "\n";

    const encoder = new TextEncoder();
    const bytes = encoder.encode(combined);

    const filename = `transcripts_${analysis.department}_${analysis.id.substring(0, 8)}.md`;

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
