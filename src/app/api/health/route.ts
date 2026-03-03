import { NextResponse } from "next/server";
import { getDbForDepartment } from "@/lib/db/index";
import { d1Users, r1Users } from "@/lib/db/schema-existing";
import { eq } from "drizzle-orm";

export async function GET() {
  const results: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    env: {
      DATABASE_URL: process.env.DATABASE_URL ? "✅ set" : "❌ NOT SET",
      R1_DATABASE_URL: process.env.R1_DATABASE_URL ? "✅ set" : "❌ NOT SET",
      D1_API_URL: process.env.D1_API_URL || "not set",
      R1_API_URL: process.env.R1_API_URL || "not set",
    },
  };

  // Test D1 (B2G) connection
  try {
    const d1Db = getDbForDepartment("b2g");
    const d1Result = await d1Db
      .select({ name: d1Users.name, role: d1Users.role })
      .from(d1Users)
      .where(eq(d1Users.isActive, true));
    results.d1_b2g = {
      status: "✅ connected",
      table: "d1_users",
      userCount: d1Result.length,
      users: d1Result.map(u => u.name).slice(0, 5),
    };
  } catch (e) {
    results.d1_b2g = { status: "❌ error", error: String(e) };
  }

  // Test R1 (B2B) connection
  try {
    const r1Db = getDbForDepartment("b2b");
    const r1Result = await r1Db
      .select({ name: r1Users.name, role: r1Users.role })
      .from(r1Users)
      .where(eq(r1Users.isActive, true));
    results.r1_b2b = {
      status: "✅ connected",
      table: "r1_users",
      userCount: r1Result.length,
      users: r1Result.map(u => u.name).slice(0, 5),
    };
  } catch (e) {
    results.r1_b2b = { status: "❌ error", error: String(e) };
  }

  return NextResponse.json(results);
}
