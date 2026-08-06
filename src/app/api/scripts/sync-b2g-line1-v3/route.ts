import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { getSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { scripts } from "@/lib/db/schema-existing";
import seed from "@/lib/scripts/b2g-seed.json";

interface CanonicalScript {
  title: string;
  notion_url?: string | null;
  source_document?: string;
  source_sheets?: string[];
  effective_from?: string;
  sections: unknown[];
}

export async function POST() {
  try {
    const session = await getSession();
    if (!session || session.role !== "admin") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const document = (seed as Record<string, CanonicalScript>)["1"];
    if (!document || !Array.isArray(document.sections)) {
      return NextResponse.json({ error: "Некорректный seed скрипта B2G линии 1" }, { status: 500 });
    }

    const existing = await db
      .select({ id: scripts.id, version: scripts.version, content: scripts.content })
      .from(scripts)
      .where(and(eq(scripts.department, "b2g"), eq(scripts.line, "1")))
      .orderBy(scripts.id)
      .limit(1);

    const currentContent = existing[0]?.content as { sourceVersion?: unknown } | undefined;
    if (currentContent?.sourceVersion === "3.0") {
      return NextResponse.json({
        success: true,
        changed: false,
        data: { id: existing[0].id, version: existing[0].version },
      });
    }

    const content = {
      sections: document.sections,
      sourceDocument: document.source_document,
      sourceSheets: document.source_sheets,
      sourceVersion: "3.0",
      effectiveFrom: document.effective_from,
    };

    const result = existing[0]
      ? await db
          .update(scripts)
          .set({
            title: document.title,
            notionUrl: document.notion_url ?? null,
            content,
            version: existing[0].version + 1,
            updatedBy: session.name,
            updatedAt: new Date(),
          })
          .where(eq(scripts.id, existing[0].id))
          .returning({ id: scripts.id, version: scripts.version, updatedAt: scripts.updatedAt })
      : await db
          .insert(scripts)
          .values({
            department: "b2g",
            line: "1",
            title: document.title,
            notionUrl: document.notion_url ?? null,
            content,
            version: 1,
            updatedBy: session.name,
          })
          .returning({ id: scripts.id, version: scripts.version, updatedAt: scripts.updatedAt });

    return NextResponse.json({ success: true, changed: true, data: result[0] });
  } catch (error) {
    console.error("[Scripts v3 sync]", error);
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
