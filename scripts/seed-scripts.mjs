// Seeds scripts into D1 DB using Neon serverless HTTP
import { neon } from "@neondatabase/serverless";
import { readFile } from "node:fs/promises";
import * as dotenv from "dotenv";

dotenv.config({ path: "/Users/user/Dashbord/.env.local" });

const sql = neon(process.env.DATABASE_URL);

const raw = await readFile("/Users/user/Dashbord/src/lib/scripts/b2g-seed.json", "utf-8");
const data = JSON.parse(raw);

for (const [line, doc] of Object.entries(data)) {
  const content = { sections: doc.sections };
  const title = doc.title;
  const notionUrl = doc.notion_url || null;
  const res = await sql`
    INSERT INTO scripts (department, line, title, notion_url, content, version, updated_by)
    VALUES ('b2g', ${line}, ${title}, ${notionUrl}, ${JSON.stringify(content)}::jsonb, 1, 'seed-import')
    ON CONFLICT (department, line) DO UPDATE SET
      title = EXCLUDED.title,
      notion_url = EXCLUDED.notion_url,
      content = EXCLUDED.content,
      version = scripts.version + 1,
      updated_by = EXCLUDED.updated_by,
      updated_at = NOW()
    RETURNING id, department, line, title, version;
  `;
  console.log(`Seeded line ${line}:`, res);
}
