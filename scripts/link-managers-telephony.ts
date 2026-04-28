// One-shot: resolve master_managers.callgear_employee_id +
// cloudtalk_agent_id for any active row that's still NULL, by name match
// against CallGear get.employees + CloudTalk /agents/index.json.
//
// Same logic the /api/managers POST handler now runs at save time, packaged
// as a CLI so we can fix the existing backlog without asking an admin to
// open and re-Save the Managers tab.
//
// Run from repo root:
//   npx tsx scripts/link-managers-telephony.ts                # dry-run (default)
//   npx tsx scripts/link-managers-telephony.ts --apply        # actually UPDATE
//   npx tsx scripts/link-managers-telephony.ts --apply --propagate-okk  # also push to OKK D2/R2 managers table

import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env.local") });

import { db } from "../src/lib/db";
import { masterManagers } from "../src/lib/db/schema-existing";
import { getOkkDbForDepartment } from "../src/lib/db/okk";
import { okkManagers } from "../src/lib/db/schema-okk";
import { getEmployees as getCallGearEmployees } from "../src/lib/telephony/callgear";
import { getAgents as getCloudTalkAgents } from "../src/lib/telephony/cloudtalk";
import { and, eq } from "drizzle-orm";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const PROPAGATE_OKK = args.includes("--propagate-okk");

function arg(name: string): string | null {
  const idx = args.indexOf(`--${name}`);
  if (idx < 0) return null;
  return args[idx + 1] ?? null;
}

const TELEPHONY_NAME_ALIASES: Record<string, string[]> = {
  "Максим Алекперов": ["Maksim Alekperov"],
  "Гульназ Сираждинова": ["Гульназ Cираждинова"],
  "Елизавета Трапезникова": ["Єлизавета Трапезникова"],
};

const norm = (s: string): string =>
  s.replace(/\(amoCRM\)/gi, "")
    .replace(/[()]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

async function main() {
  const deptArg = arg("dept");
  const filterDept = deptArg === "b2b" || deptArg === "b2g" ? deptArg : null;

  console.log(`Mode: ${APPLY ? "APPLY" : "DRY-RUN (use --apply to write)"}`);
  if (PROPAGATE_OKK) console.log("Propagate to OKK: ENABLED");
  console.log("");

  // 1) Fetch CallGear employees
  console.log("[1/3] Fetching CallGear employees…");
  const cgByName = new Map<string, string>();
  try {
    const employees = await getCallGearEmployees();
    for (const e of employees) {
      if (!e.id) continue;
      const id = String(e.id);
      if (e.full_name) cgByName.set(norm(e.full_name), id);
      if (e.first_name && e.last_name) {
        cgByName.set(norm(`${e.first_name} ${e.last_name}`), id);
      }
    }
    console.log(`     loaded ${employees.length} employees, ${cgByName.size} name keys`);
  } catch (err) {
    console.warn(`     CallGear fetch failed: ${err instanceof Error ? err.message : err}`);
  }

  // 2) Fetch CloudTalk agents
  console.log("[2/3] Fetching CloudTalk agents…");
  const ctByName = new Map<string, string>();
  const ctByEmail = new Map<string, string>();
  try {
    const agents = await getCloudTalkAgents();
    for (const a of agents) {
      if (!a.id) continue;
      const id = String(a.id);
      const fn = [a.firstname, a.lastname].filter(Boolean).join(" ").trim();
      if (fn) ctByName.set(norm(fn), id);
      if (a.email) ctByEmail.set(a.email.toLowerCase().trim(), id);
    }
    console.log(`     loaded ${agents.length} agents, ${ctByName.size} name keys, ${ctByEmail.size} emails`);
  } catch (err) {
    console.warn(`     CloudTalk fetch failed: ${err instanceof Error ? err.message : err}`);
  }

  const lookup = (map: Map<string, string>, name: string): string | null => {
    const direct = map.get(norm(name));
    if (direct) return direct;
    const aliases = TELEPHONY_NAME_ALIASES[name.trim()];
    if (aliases) {
      for (const alias of aliases) {
        const hit = map.get(norm(alias));
        if (hit) return hit;
      }
    }
    return null;
  };

  // 3) Walk master_managers
  console.log("[3/3] Walking master_managers…");
  const conds = [eq(masterManagers.isActive, true)];
  if (filterDept) conds.push(eq(masterManagers.department, filterDept));
  const masters = await db
    .select()
    .from(masterManagers)
    .where(and(...conds));

  let touched = 0;
  let cgFilled = 0;
  let ctFilled = 0;
  const stillMissing: { name: string; dept: string; cg: boolean; ct: boolean }[] = [];

  for (const m of masters) {
    const wantCg = !m.callgearEmployeeId;
    const wantCt = !m.cloudtalkAgentId;
    if (!wantCg && !wantCt) continue;

    const newCg = wantCg ? lookup(cgByName, m.name) : null;
    const newCt = wantCt ? lookup(ctByName, m.name) : null;

    if (!newCg && !newCt) {
      stillMissing.push({ name: m.name, dept: m.department, cg: wantCg, ct: wantCt });
      continue;
    }

    const finalCg = m.callgearEmployeeId ?? newCg ?? null;
    const finalCt = m.cloudtalkAgentId ?? newCt ?? null;

    console.log(
      `  ${m.department.toUpperCase().padEnd(4)} ${m.name.padEnd(28)} ` +
        `cg=${m.callgearEmployeeId ?? "—"}→${finalCg ?? "—"}  ct=${m.cloudtalkAgentId ?? "—"}→${finalCt ?? "—"}`,
    );

    if (newCg) cgFilled++;
    if (newCt) ctFilled++;
    touched++;

    if (APPLY) {
      await db
        .update(masterManagers)
        .set({
          callgearEmployeeId: finalCg,
          cloudtalkAgentId: finalCt,
          updatedAt: new Date(),
        })
        .where(eq(masterManagers.id, m.id));

      if (PROPAGATE_OKK && m.inOkk) {
        const okkDept = m.department === "b2g" ? "d2" : "r2";
        const okkDb = getOkkDbForDepartment(m.department);
        try {
          // Best-effort: update by name + dept (same matching key as
          // syncToTargets in /api/managers).
          await okkDb
            .update(okkManagers)
            .set({
              callgearEmployeeId: finalCg,
              cloudtalkAgentId: finalCt,
            })
            .where(
              and(
                eq(okkManagers.name, m.name),
                eq(okkManagers.department, okkDept),
                eq(okkManagers.isActive, true),
              ),
            );
        } catch (err) {
          console.warn(`     OKK propagate failed for ${m.name}: ${err instanceof Error ? err.message : err}`);
        }
      }
    }
  }

  console.log("");
  console.log("=== SUMMARY ===");
  console.log(`Master managers walked: ${masters.length}`);
  console.log(`Rows ${APPLY ? "updated" : "would-be-updated"}: ${touched}  (cg filled: ${cgFilled}, ct filled: ${ctFilled})`);

  if (stillMissing.length > 0) {
    console.log(`\nStill missing (no API match):`);
    for (const m of stillMissing) {
      const tags = [m.cg ? "cg" : null, m.ct ? "ct" : null].filter(Boolean).join("+");
      console.log(`  ${m.dept.toUpperCase().padEnd(4)} ${m.name.padEnd(28)} need: ${tags}`);
    }
    console.log(
      `\nThese managers exist in master_managers but were not found in CallGear / CloudTalk by name. ` +
        `Either they don't have a telephony account, or their name there differs (add to TELEPHONY_NAME_ALIASES).`,
    );
  }

  if (!APPLY) {
    console.log(`\nDry-run complete. Re-run with --apply to write changes.`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("fatal:", err);
    process.exit(1);
  });
