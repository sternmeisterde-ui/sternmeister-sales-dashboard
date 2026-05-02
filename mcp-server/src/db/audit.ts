/**
 * Audit middleware — every tool invocation lands in mcp_audit_log (D1).
 * Fire-and-forget; failures to write the audit row are NOT fatal to the
 * tool call (we log to stderr but keep responding).
 */

import { sql } from "drizzle-orm";

import { d1 } from "./connections.js";
import type { CallContext } from "../auth/context.js";

export interface AuditEntry {
  ctx: CallContext;
  toolName: string;
  toolInput: unknown;
  durationMs: number;
  rowsReturned: number | null;
  status: "ok" | "error" | "denied";
  errorMsg?: string;
  rawSql?: string;
  why?: string;
}

export async function recordAudit(entry: AuditEntry): Promise<void> {
  try {
    // user_depts is text[] — Drizzle's parameterizer stringifies arrays
    // into a comma-joined value, which Postgres rejects ("malformed array
    // literal"). Cast through string_to_array to coerce reliably.
    const deptsCsv = entry.ctx.depts.join(",");
    await d1.execute(sql`
      INSERT INTO mcp_audit_log (
        user_id, user_role, user_depts, transport,
        tool_name, tool_input, duration_ms, rows_returned,
        status, error_msg, raw_sql, why
      ) VALUES (
        ${entry.ctx.userId},
        ${entry.ctx.role},
        string_to_array(${deptsCsv}, ','),
        ${entry.ctx.transport},
        ${entry.toolName},
        ${JSON.stringify(entry.toolInput)}::jsonb,
        ${entry.durationMs},
        ${entry.rowsReturned},
        ${entry.status},
        ${entry.errorMsg ?? null},
        ${entry.rawSql ?? null},
        ${entry.why ?? null}
      )
    `);
  } catch (err) {
    // Best-effort: don't break tool call if audit write fails.
    process.stderr.write(`[mcp-audit] failed to write entry: ${(err as Error).message}\n`);
  }
}
