import dns from "node:dns";
import net from "node:net";
dns.setDefaultResultOrder("ipv4first");
net.setDefaultAutoSelectFamily(true);
net.setDefaultAutoSelectFamilyAttemptTimeout(500);
import { readFileSync } from "node:fs";
import { neon } from "@neondatabase/serverless";
import { config } from "dotenv";
config({ path: ".env.local" });

const sql = neon(process.env.DATABASE_URL);
const text = readFileSync("drizzle/d1/0005_complaints_comment.sql", "utf8");
const statements = text
  .split(/;\s*\r?\n/)
  .map((s) => s.replace(/^\s*--.*$/gm, "").trim())
  .filter((s) => s && s !== "BEGIN" && s !== "COMMIT");
for (const [i, stmt] of statements.entries()) {
  await sql.query(stmt);
  console.log(`ok ${i + 1}/${statements.length}: ${stmt.slice(0, 70).replace(/\s+/g, " ")}`);
}
const norm = (r) => (Array.isArray(r) ? r : r.rows);
const chk = await sql.query(
  "SELECT column_name FROM information_schema.columns WHERE table_name='complaints' AND column_name='comment'",
);
console.log("comment column exists:", norm(chk).length === 1);
