/**
 * Tool registration helper — wraps every domain handler with policy gate +
 * audit log + canonical error formatting. Domains call `registerTool(...)`
 * once per tool instead of touching auth/audit boilerplate themselves.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodRawShape, infer as zInfer, ZodObject } from "zod";
import { z } from "zod";

import { recordAudit } from "../db/audit.js";
import { getCurrentContext } from "../auth/context.js";
import type { CallContext } from "../auth/context.js";
import { checkPolicy } from "../auth/policy.js";
import type { ToolPolicy } from "../auth/policy.js";
import { captureError } from "../utils/trace.js";

type ParsedInput<I extends ZodRawShape> = zInfer<ZodObject<I>>;

export interface ToolDef<I extends ZodRawShape> {
  /** Namespaced tool name, e.g. 'managers.list'. */
  name: string;
  description: string;
  inputShape: I;
  policy: ToolPolicy;
  /**
   * Pulls the dept field out of input for the policy gate. Tools that
   * don't operate on a specific dept omit this.
   */
  deptArg?: (input: ParsedInput<I>) => "b2g" | "b2b" | undefined;
  handler: (input: ParsedInput<I>, ctx: CallContext) => Promise<unknown>;
}

function rowCount(out: unknown): number | null {
  if (Array.isArray(out)) return out.length;
  if (
    out !== null &&
    typeof out === "object" &&
    "rows" in out &&
    Array.isArray((out as { rows: unknown }).rows)
  ) {
    return (out as { rows: unknown[] }).rows.length;
  }
  return null;
}

// Result type emitted to MCP SDK. We construct it manually to avoid letting
// TS infer through the SDK's deep CallToolResult tree (caused TS2589).
type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
};

// Untyped binding to McpServer.registerTool — sidesteps the SDK's deeply
// generic overload set (caused TS2589 with our own generic wrapper). At
// runtime we still pass exactly what the SDK expects.
type RawRegisterTool = (
  name: string,
  config: { description: string; inputSchema: ZodRawShape },
  handler: (input: unknown) => Promise<ToolResult>,
) => void;

export function registerTool<I extends ZodRawShape>(
  server: McpServer,
  def: ToolDef<I>,
): void {
  const inputSchema = z.object(def.inputShape);
  const register = server.registerTool.bind(server) as unknown as RawRegisterTool;

  register(
    def.name,
    {
      description: def.description,
      inputSchema: def.inputShape,
    },
    async (rawInput: unknown): Promise<ToolResult> => {
      const ctx = getCurrentContext();
      const t0 = Date.now();
      // Re-parse defensively — if the SDK passed something invalid we surface
      // it as a 'denied' rather than crashing in the handler.
      const parseResult = inputSchema.safeParse(rawInput);
      if (!parseResult.success) {
        const reason = `input validation: ${parseResult.error.message}`;
        void recordAudit({
          ctx,
          toolName: def.name,
          toolInput: rawInput,
          durationMs: Date.now() - t0,
          rowsReturned: null,
          status: "denied",
          errorMsg: reason,
        });
        return {
          content: [{ type: "text", text: `Bad input: ${reason}` }],
          isError: true,
        };
      }
      const input = parseResult.data as ParsedInput<I>;
      const dept = def.deptArg?.(input);
      const decision = checkPolicy(ctx, def.policy, dept);
      if (!decision.ok) {
        const reason = decision.reason ?? "policy denied";
        void recordAudit({
          ctx,
          toolName: def.name,
          toolInput: input,
          durationMs: Date.now() - t0,
          rowsReturned: null,
          status: "denied",
          errorMsg: reason,
        });
        return {
          content: [{ type: "text", text: `Access denied: ${reason}` }],
          isError: true,
        };
      }
      try {
        const out = await def.handler(input, ctx);
        void recordAudit({
          ctx,
          toolName: def.name,
          toolInput: input,
          durationMs: Date.now() - t0,
          rowsReturned: rowCount(out),
          status: "ok",
        });
        return {
          content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
          structuredContent: out as Record<string, unknown>,
        };
      } catch (err) {
        const rawMsg = (err as Error).message ?? String(err);
        // Full message goes to stderr (and Sentry) for debugging; audit
        // log keeps a 500-char head + 250-char tail because Postgres
        // errors put the cause at the start and position/line at the end.
        process.stderr.write(`[mcp-tool-error] ${def.name}: ${rawMsg}\n`);
        const msg =
          rawMsg.length > 750
            ? `${rawMsg.slice(0, 500)}…[truncated ${rawMsg.length - 750}ch]…${rawMsg.slice(-250)}`
            : rawMsg.slice(0, 750);
        const durationMs = Date.now() - t0;
        captureError(err, {
          tool: def.name,
          user_id: ctx.userId,
          user_role: ctx.role,
          transport: ctx.transport,
          dept: dept ?? "",
          duration_ms: durationMs,
        });
        void recordAudit({
          ctx,
          toolName: def.name,
          toolInput: input,
          durationMs,
          rowsReturned: null,
          status: "error",
          errorMsg: msg,
        });
        return {
          content: [{ type: "text", text: `Error: ${msg}` }],
          isError: true,
        };
      }
    },
  );
}
