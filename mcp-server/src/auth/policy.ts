/**
 * Role/dept policy gates. Applied in the tool registry's wrap() before the
 * actual tool handler runs. Returns either { ok: true } or { ok: false,
 * reason } — the registry surfaces denials as audit-logged "denied" events.
 */

import type { CallContext } from "./context.js";
import type { TokenClaims } from "./tokens.js";

export interface ToolPolicy {
  /** Allowed roles. Default: all roles. */
  roles?: ReadonlyArray<TokenClaims["role"]>;
  /**
   * `'self'` — manager-role users may only see their own data (enforced
   * downstream — the registry just validates this is a valid scope value).
   * `'b2g' | 'b2b'` — tool always operates on this dept (the dept arg is
   * required to match).
   * Omit if dept is irrelevant to this tool.
   */
  scope?: "self" | "b2g" | "b2b";
}

export interface PolicyDecision {
  ok: boolean;
  reason?: string;
}

export function checkPolicy(
  ctx: CallContext,
  policy: ToolPolicy,
  inputDept?: "b2g" | "b2b",
): PolicyDecision {
  if (policy.roles && !policy.roles.includes(ctx.role)) {
    return { ok: false, reason: `role '${ctx.role}' not allowed; need one of ${policy.roles.join(", ")}` };
  }
  if (inputDept && !ctx.depts.includes("*") && !ctx.depts.includes(inputDept)) {
    return { ok: false, reason: `dept '${inputDept}' not in user's scope ${JSON.stringify(ctx.depts)}` };
  }
  return { ok: true };
}
