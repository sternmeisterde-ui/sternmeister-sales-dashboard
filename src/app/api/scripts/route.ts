import { NextRequest, NextResponse } from "next/server";
import { eq, and } from "drizzle-orm";
import { getSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { scripts } from "@/lib/db/schema-existing";
import {
  DEPARTMENTS,
  isValidLineId,
  type DepartmentId,
} from "@/lib/config/tenant";

function isValidDepartment(value: unknown): value is DepartmentId {
  return typeof value === "string" && value in DEPARTMENTS;
}

function isValidLine(department: DepartmentId, line: unknown): line is string {
  return typeof line === "string" && isValidLineId(department, line);
}

// Minimal runtime validation — tolerant of missing optional fields
function isValidContent(value: unknown): value is { sections: unknown[] } {
  if (!value || typeof value !== "object") return false;
  const sections = (value as { sections?: unknown }).sections;
  return Array.isArray(sections);
}

// ─── GET /api/scripts?department=b2g&line=1 ─────────────────────────

export async function GET(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const department = request.nextUrl.searchParams.get("department");
    const line = request.nextUrl.searchParams.get("line");

    if (!isValidDepartment(department)) {
      return NextResponse.json({ error: "Invalid department" }, { status: 400 });
    }
    // Не-админы читают только скрипты своего отдела.
    if (session.role !== "admin" && department !== session.department) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    if (!isValidLine(department, line)) {
      return NextResponse.json({ error: "Invalid line for department" }, { status: 400 });
    }

    const rows = await db
      .select()
      .from(scripts)
      .where(and(eq(scripts.department, department), eq(scripts.line, line)))
      .limit(1);

    const row = rows[0];
    if (!row) {
      return NextResponse.json({
        success: true,
        data: {
          exists: false,
          department,
          line,
          title: "",
          notionUrl: null,
          content: { sections: [] },
          version: 0,
          updatedAt: null,
          updatedBy: null,
        },
      });
    }

    return NextResponse.json({
      success: true,
      data: {
        exists: true,
        id: row.id,
        department: row.department,
        line: row.line,
        title: row.title,
        notionUrl: row.notionUrl,
        content: row.content,
        version: row.version,
        updatedAt: row.updatedAt,
        updatedBy: row.updatedBy,
      },
    });
  } catch (error) {
    console.error("[Scripts API GET]", error);
    const msg = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// ─── POST /api/scripts ──────────────────────────────────────────────

export async function POST(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session || session.role !== "admin") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = await request.json();
    const { department, line, title, notionUrl, content } = body as {
      department: unknown;
      line: unknown;
      title?: unknown;
      notionUrl?: unknown;
      content: unknown;
    };

    if (!isValidDepartment(department)) {
      return NextResponse.json({ error: "Invalid department" }, { status: 400 });
    }
    if (!isValidLine(department, line)) {
      return NextResponse.json({ error: "Invalid line for department" }, { status: 400 });
    }
    if (!isValidContent(content)) {
      return NextResponse.json({ error: "Invalid content: { sections: [] } required" }, { status: 400 });
    }

    const titleStr = typeof title === "string" && title.trim() ? title.trim() : `${department.toUpperCase()} — Линия ${line}`;
    const notionUrlStr = typeof notionUrl === "string" ? notionUrl : null;

    // Upsert
    const existing = await db
      .select({ id: scripts.id, version: scripts.version })
      .from(scripts)
      .where(and(eq(scripts.department, department), eq(scripts.line, line)))
      .limit(1);

    if (existing[0]) {
      const updated = await db
        .update(scripts)
        .set({
          title: titleStr,
          notionUrl: notionUrlStr,
          content: content as object,
          version: existing[0].version + 1,
          updatedBy: session.name,
          updatedAt: new Date(),
        })
        .where(eq(scripts.id, existing[0].id))
        .returning({
          id: scripts.id,
          version: scripts.version,
          updatedAt: scripts.updatedAt,
        });

      return NextResponse.json({ success: true, data: updated[0] });
    }

    const inserted = await db
      .insert(scripts)
      .values({
        department,
        line,
        title: titleStr,
        notionUrl: notionUrlStr,
        content: content as object,
        version: 1,
        updatedBy: session.name,
      })
      .returning({
        id: scripts.id,
        version: scripts.version,
        updatedAt: scripts.updatedAt,
      });

    return NextResponse.json({ success: true, data: inserted[0] });
  } catch (error) {
    console.error("[Scripts API POST]", error);
    const msg = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
