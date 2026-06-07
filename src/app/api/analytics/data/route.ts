import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { analyticsDb } from "@/lib/db/analytics";
import { sql } from "drizzle-orm";

const TABLE_CONFIG = {
  leads_cohort: {
    dateCol: "created_at",
    schema: "analytics",
    filterCols: ["manager", "pipeline", "status", "category", "utm_source"],
  },
  communications: {
    dateCol: "created_at",
    schema: "analytics",
    filterCols: ["manager", "communication_type", "pipeline_name"],
  },
  lead_status_changes: {
    dateCol: "event_at",
    schema: "analytics",
    filterCols: ["manager", "pipeline"],
  },
  tasks: {
    dateCol: "task_created_at",
    schema: "analytics",
    filterCols: ["lead_manager", "task_manager"],
  },
  sla: {
    dateCol: "lead_created_at",
    schema: "analytics",
    filterCols: ["manager", "pipeline_name", "sla_status"],
  },
  // NOTE: sales_report / ads_report / custom_report / funnel removed —
  // never-materialised integrator mirrors (0 rows), dropped in analytics
  // migration 0024_drop_dead_mirror_tables.sql.
} as const;

type TableKey = keyof typeof TABLE_CONFIG;

function isTableKey(key: string): key is TableKey {
  return key in TABLE_CONFIG;
}

function clampInt(value: string | null, defaultVal: number, max: number): number {
  if (!value) return defaultVal;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < 0) return defaultVal;
  return Math.min(parsed, max);
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const session = await getSession();
    if (!session || session.role !== "admin") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const sp = request.nextUrl.searchParams;
    const tableParam = sp.get("table") ?? "";

    if (!isTableKey(tableParam)) {
      return NextResponse.json({ error: "Invalid table name" }, { status: 400 });
    }

    const config = TABLE_CONFIG[tableParam];
    const { dateCol, schema, filterCols } = config;
    const qualifiedTable = `${schema}.${tableParam}`;

    const now = new Date();
    const defaultFrom = new Date(now);
    defaultFrom.setUTCDate(defaultFrom.getUTCDate() - 30);

    const fromStr = sp.get("from") ?? defaultFrom.toISOString().slice(0, 10);
    const toStr = sp.get("to") ?? now.toISOString().slice(0, 10);
    const fromDate = `${fromStr}T00:00:00Z`;
    const toDate = `${toStr}T23:59:59Z`;

    const limit = clampInt(sp.get("limit"), 100, 500);
    const offset = clampInt(sp.get("offset"), 0, Number.MAX_SAFE_INTEGER);

    const activeFilters: Array<{ col: string; value: string }> = [];
    for (const col of filterCols) {
      const val = sp.get(col);
      if (val) activeFilters.push({ col, value: val });
    }

    const whereParts: ReturnType<typeof sql>[] = [
      sql.raw(`"${dateCol}" >= '${fromDate}'::timestamptz`),
      sql.raw(`"${dateCol}" <= '${toDate}'::timestamptz`),
    ];

    for (const { col, value } of activeFilters) {
      whereParts.push(sql`"${sql.raw(col)}" = ${value}`);
    }

    const whereClause = sql.join(whereParts, sql` AND `);

    const [countResult, rowsResult] = await Promise.all([
      analyticsDb.execute<{ count: string }>(
        sql`SELECT COUNT(*) AS count FROM ${sql.raw(qualifiedTable)} WHERE ${whereClause}`,
      ),
      analyticsDb.execute<Record<string, unknown>>(
        sql`SELECT * FROM ${sql.raw(qualifiedTable)} WHERE ${whereClause} ORDER BY "${sql.raw(dateCol)}" DESC LIMIT ${limit} OFFSET ${offset}`,
      ),
    ]);

    const total = Number(countResult.rows[0]?.count ?? 0);
    const rows = rowsResult.rows;

    const filterOptionResults = await Promise.all(
      filterCols.map(async (col) => {
        const res = await analyticsDb.execute<{ val: string }>(
          sql`SELECT DISTINCT "${sql.raw(col)}" AS val FROM ${sql.raw(qualifiedTable)} WHERE ${whereClause} AND "${sql.raw(col)}" IS NOT NULL ORDER BY val LIMIT 200`,
        );
        return { col, values: res.rows.map((r) => String(r.val)) };
      }),
    );

    const filterOptions: Record<string, string[]> = {};
    for (const { col, values } of filterOptionResults) {
      filterOptions[col] = values;
    }

    return NextResponse.json({ table: tableParam, total, rows, filterOptions });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal server error";
    console.error("[Analytics Data API]", error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
