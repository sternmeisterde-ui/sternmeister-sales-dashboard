/**
 * repoint-mcp-readonly-fra.mjs — tech-debt #4: создаёт роль mcp_readonly на
 * всех 6 Frankfurt-ветках (D1, R1, D2, R2, Analytics, Tracking), выдаёт
 * read-only гранты и пишет 6 готовых MCP_*_RO_URL в файл.
 *
 * Отличие от rotate-mcp-readonly.mjs: тот только меняет пароль существующей
 * роли и хардкодит старые US-хосты. Этот — создаёт роль с нуля (после
 * миграции us-east-1 → eu-central-1 роли на новых проектах нет) и берёт
 * хост/базу из admin-URL программно, без хардкода.
 *
 * Пароль не попадает в stdout: генерируется в <tmpdir>/mcp_pwd_fra (как у
 * rotate-скрипта), URL-файл — <tmpdir>/mcp-ro-urls-fra.env. Запуск:
 *   node scripts/repoint-mcp-readonly-fra.mjs          # reuse пароля
 *   node scripts/repoint-mcp-readonly-fra.mjs --gen    # свежий пароль
 * Затем содержимое файла — в Dokploy env UI + restart mcp.
 */
import { neon } from "@neondatabase/serverless";
import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

const PWD_FILE = join(tmpdir(), "mcp_pwd_fra");
const OUT_FILE = join(tmpdir(), "mcp-ro-urls-fra.env");

if (process.argv.includes("--gen")) {
  await fs.writeFile(PWD_FILE, randomBytes(32).toString("hex"), { mode: 0o600 });
  process.stdout.write(`[repoint] generated fresh ${PWD_FILE}\n`);
}
const pwd = (await fs.readFile(PWD_FILE, "utf8")).trim();
if (!/^[0-9a-fA-F]{32,}$/.test(pwd)) {
  process.stderr.write("[repoint] пароль отсутствует/не hex — запусти с --gen\n");
  process.exit(1);
}

// .env.local дефект: TRACKING_DATABASE_URL склеен с CRON_SECRET= в одну строку
const clean = (u) => (u ? u.split("CRON_SECRET=")[0].trim() : u);

const TARGETS = [
  { key: "MCP_D1_RO_URL",        name: "D1 (sm-d1-fra)",        url: clean(process.env.DATABASE_URL) },
  { key: "MCP_R1_RO_URL",        name: "R1 (sm-r1-fra)",        url: clean(process.env.R1_DATABASE_URL) },
  { key: "MCP_D2_RO_URL",        name: "D2 (okk-d2-fra)",       url: clean(process.env.D2_OKK_DATABASE_URL) },
  { key: "MCP_R2_RO_URL",        name: "R2 (okk-r2-fra)",       url: clean(process.env.R2_OKK_DATABASE_URL) },
  { key: "MCP_ANALYTICS_RO_URL", name: "Analytics (analytics-fra)", url: clean(process.env.ANALYTICS_DATABASE_URL) },
  { key: "MCP_TRACKING_RO_URL",  name: "Tracking (tracking-fra)",   url: clean(process.env.TRACKING_DATABASE_URL) },
];

const outLines = [];
let failed = 0;

for (const t of TARGETS) {
  if (!t.url) { process.stderr.write(`[repoint] ${t.name}: admin URL отсутствует — SKIP\n`); failed++; continue; }
  let host, dbName;
  try {
    const u = new URL(t.url);
    if (!u.hostname.includes("eu-central-1")) throw new Error(`admin URL не eu-central-1: ${u.hostname}`);
    host = u.hostname; dbName = u.pathname.replace(/^\//, "");
  } catch (e) { process.stderr.write(`[repoint] ${t.name}: ${e.message} — SKIP\n`); failed++; continue; }

  const sql = neon(t.url);
  try {
    const exists = await sql.query(`SELECT 1 FROM pg_roles WHERE rolname = 'mcp_readonly'`);
    if (exists.length === 0) {
      await sql.query(`CREATE ROLE mcp_readonly WITH LOGIN PASSWORD '${pwd}'`);
      process.stdout.write(`[repoint] ${t.name}: роль создана\n`);
    } else {
      await sql.query(`ALTER ROLE mcp_readonly WITH LOGIN PASSWORD '${pwd}'`);
      process.stdout.write(`[repoint] ${t.name}: роль уже была — пароль обновлён\n`);
    }
    await sql.query(`GRANT CONNECT ON DATABASE "${dbName}" TO mcp_readonly`);
    // гранты на ВСЕ пользовательские схемы (у analytics-fra витрины в схеме "analytics", не в public)
    const schemas = await sql.query(
      `SELECT schema_name FROM information_schema.schemata
       WHERE schema_name NOT IN ('pg_catalog','information_schema') AND schema_name NOT LIKE 'pg_%'`);
    const schemaNames = schemas.map((r) => r.schema_name);
    for (const s of schemaNames) {
      await sql.query(`GRANT USAGE ON SCHEMA "${s}" TO mcp_readonly`);
      await sql.query(`GRANT SELECT ON ALL TABLES IN SCHEMA "${s}" TO mcp_readonly`);
      await sql.query(`ALTER DEFAULT PRIVILEGES FOR ROLE neondb_owner IN SCHEMA "${s}" GRANT SELECT ON TABLES TO mcp_readonly`);
    }
    process.stdout.write(`[repoint] ${t.name}: схемы → ${schemaNames.join(", ")}\n`);

    // верификация: под mcp_readonly SELECT работает, запись — нет
    const roUrl = `postgresql://mcp_readonly:${pwd}@${host}/${dbName}?sslmode=require&channel_binding=require`;
    const ro = neon(roUrl);
    const probe = await ro.query(
      `SELECT count(*)::int AS n FROM information_schema.tables
       WHERE table_schema NOT IN ('pg_catalog','information_schema') AND table_schema NOT LIKE 'pg_%'`);
    let writeBlocked = false;
    try { await ro.query(`CREATE TABLE _sb_probe_should_fail(x int)`); } catch { writeBlocked = true; }
    if (!writeBlocked) {
      await sql.query(`DROP TABLE IF EXISTS _sb_probe_should_fail`);
      throw new Error("роль СМОГЛА создать таблицу — гранты неверны");
    }
    process.stdout.write(`[repoint] ${t.name}: verify OK (SELECT: ${probe[0].n} таблиц видно, запись заблокирована)\n`);
    outLines.push(`${t.key}=${roUrl}`);
  } catch (e) {
    process.stderr.write(`[repoint] ${t.name}: FAIL — ${e.message}\n`);
    failed++;
  }
}

await fs.writeFile(OUT_FILE, outLines.join("\n") + "\n", { mode: 0o600 });
process.stdout.write(`\n[repoint] записано ${outLines.length}/6 URL → ${OUT_FILE}\n`);
if (failed) { process.stdout.write(`[repoint] ОШИБОК: ${failed} — см. stderr выше\n`); process.exit(1); }
process.stdout.write(`[repoint] дальше: содержимое файла → Dokploy env UI (сервис mcp) → restart\n`);
