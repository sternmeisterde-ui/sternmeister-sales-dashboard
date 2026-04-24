// Resolve the list of analytics-side manager names that belong to a department.
//
// Source of truth: `master_managers` (D1) filtered by `department`, `role='manager'`,
// `is_active=true`. The integrator's feed (analytics.leads_cohort.manager,
// analytics.communications.manager) uses display names that drift from the canonical
// spellings (Latin vs Cyrillic, Ukrainian Є vs Russian Е). We fold in NAME_ALIASES
// so the whitelist matches whatever spelling the integrator wrote.
//
// Used by the Looker tab API to strip out: role=rop/admin, managers of the other
// department who got attached to a lead in the wrong pipeline, and any legacy names
// (Rose, Виктор, etc.) that aren't in master_managers at all.

import { db } from "@/lib/db";
import { masterManagers } from "@/lib/db/schema-existing";
import { and, eq, isNotNull, or } from "drizzle-orm";
import { NAME_ALIASES } from "./name-aliases";

export interface DeptManagerWhitelist {
  /** Every name the integrator might write for this dept (canonical + aliases). */
  names: string[];
  /** Alias → canonical master_managers.name, for normalising output. */
  aliasToCanonical: Map<string, string>;
}

export async function getDeptManagerWhitelist(
  department: "b2g" | "b2b" | string,
): Promise<DeptManagerWhitelist> {
  const dept = department === "b2b" ? "b2b" : "b2g";
  // Double-status convention: role='rop' + line IS NOT NULL means the person
  // is also a working manager on that line (currently applies to Татьяна
  // Дерикова, b2g, line=2). They must be included in the Looker whitelist.
  const rows = await db
    .select({ name: masterManagers.name })
    .from(masterManagers)
    .where(
      and(
        eq(masterManagers.department, dept),
        eq(masterManagers.isActive, true),
        or(
          eq(masterManagers.role, "manager"),
          and(eq(masterManagers.role, "rop"), isNotNull(masterManagers.line)),
        ),
      ),
    );

  const names = new Set<string>();
  const aliasToCanonical = new Map<string, string>();
  for (const { name } of rows) {
    names.add(name);
    aliasToCanonical.set(name, name);
    const aliases = NAME_ALIASES[name];
    if (aliases) {
      for (const a of aliases) {
        names.add(a);
        aliasToCanonical.set(a, name);
      }
    }
  }
  return { names: [...names], aliasToCanonical };
}
