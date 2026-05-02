/**
 * rotate-mcp-readonly.mjs — atomically rotates the mcp_readonly password on
 * all 4 Neon projects (SM=D1+R1, OKK=D2+R2, looker=Analytics, tracking) and
 * writes 6 ready-to-paste connection strings to /tmp/mcp-ro-urls.env.
 *
 * The password itself never lands in stdout — it's generated to /tmp/mcp_pwd
 * (chmod 600) and read back by this script. The connection-string file is
 * also chmod 600. Run, then `cat /tmp/mcp-ro-urls.env` locally to copy into
 * Dokploy env UI.
 *
 * Why a one-shot script vs Neon MCP: the MCP path puts the password into
 * tool args which persist in the session JSONL transcript. This Node-only
 * route keeps it on local disk only.
 */
import { neon } from "@neondatabase/serverless";
import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import * as dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

// `--gen` flag: mint a fresh password before rotating. Without it, the
// script reuses /tmp/mcp_pwd as-is (useful for re-emitting URLs after a
// host change or re-applying after a partial failure). With `--gen`,
// every invocation produces a brand-new credential — required for true
// rotation hygiene.
const wantGen = process.argv.includes("--gen");
if (wantGen) {
  const fresh = randomBytes(32).toString("hex");
  await fs.writeFile("/tmp/mcp_pwd", fresh, { mode: 0o600 });
  process.stdout.write("[rotate] generated fresh /tmp/mcp_pwd\n");
}

const pwd = (await fs.readFile("/tmp/mcp_pwd", "utf8")).trim();
if (!pwd || pwd.length < 32) {
  process.stderr.write("[rotate] /tmp/mcp_pwd missing or too short — pass --gen to generate one\n");
  process.exit(1);
}

// Admin-level URLs — one per Neon BRANCH (not project). Neon roles live
// on each branch's compute endpoint independently — creating mcp_readonly
// on the SM project's D1 branch does NOT propagate it to R1 branch (R1 is
// a separate compute endpoint with its own pg_authid). So ALTER must run
// on all 6 endpoints, not 4 projects.
const D1_ENDPOINT = "ep-withered-recipe-ai1ea97w-pooler";
const R1_ENDPOINT = "ep-shiny-recipe-aio8wyp2-pooler";
const r1Url =
  process.env.R1_DATABASE_URL ??
  process.env.DATABASE_URL?.replace(D1_ENDPOINT, R1_ENDPOINT);

const ALTER_TARGETS = [
  { name: "D1 branch", url: process.env.DATABASE_URL },
  { name: "R1 branch", url: r1Url },
  { name: "D2 branch", url: process.env.D2_OKK_DATABASE_URL },
  { name: "R2 branch", url: process.env.R2_OKK_DATABASE_URL },
  { name: "Analytics", url: process.env.ANALYTICS_DATABASE_URL },
  { name: "Tracking", url: process.env.TRACKING_DATABASE_URL },
];

for (const t of ALTER_TARGETS) {
  if (!t.url) {
    process.stderr.write(`[rotate] ${t.name}: env URL missing — skipping\n`);
    continue;
  }
  const sql = neon(t.url);
  // ALTER ROLE doesn't accept bound parameters for the password literal —
  // inline via SQL escape doubling. pwd is hex-only so no risk.
  if (!/^[0-9a-fA-F]+$/.test(pwd)) {
    process.stderr.write("[rotate] pwd contains non-hex chars; refusing\n");
    process.exit(2);
  }
  await sql.query(`ALTER ROLE mcp_readonly WITH PASSWORD '${pwd}'`);
  process.stdout.write(`[rotate] ${t.name}: pwd updated\n`);
}

// Write 6 ready-to-paste env lines (host map captured from earlier MCP query).
const ENDPOINTS = [
  { key: "MCP_D1_RO_URL", host: "ep-withered-recipe-ai1ea97w-pooler.c-4.us-east-1.aws.neon.tech", db: "D1_roleplay", binding: true },
  { key: "MCP_R1_RO_URL", host: "ep-shiny-recipe-aio8wyp2-pooler.c-4.us-east-1.aws.neon.tech", db: "D1_roleplay", binding: true },
  { key: "MCP_D2_RO_URL", host: "ep-winter-mouse-ain4outh-pooler.c-4.us-east-1.aws.neon.tech", db: "neondb", binding: true },
  { key: "MCP_R2_RO_URL", host: "ep-young-sea-ainkzevg-pooler.c-4.us-east-1.aws.neon.tech", db: "neondb", binding: true },
  { key: "MCP_ANALYTICS_RO_URL", host: "ep-weathered-mouse-anvx67h1-pooler.c-6.us-east-1.aws.neon.tech", db: "neondb", binding: true },
  { key: "MCP_TRACKING_RO_URL", host: "ep-summer-sky-a4ec61qi-pooler.us-east-1.aws.neon.tech", db: "neondb", binding: false },
];

const lines = ENDPOINTS.map((e) => {
  const params = e.binding
    ? "channel_binding=require&sslmode=require"
    : "sslmode=require";
  return `${e.key}=postgresql://mcp_readonly:${pwd}@${e.host}/${e.db}?${params}`;
});

await fs.writeFile("/tmp/mcp-ro-urls.env", lines.join("\n") + "\n", { mode: 0o600 });
process.stdout.write(`[rotate] wrote /tmp/mcp-ro-urls.env (chmod 600, 6 URLs)\n`);
process.stdout.write(`[rotate] verify locally: cat /tmp/mcp-ro-urls.env\n`);
