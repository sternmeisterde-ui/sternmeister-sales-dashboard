// Синхронизация нового скрипта квалификатора в D1.
// По умолчанию только показывает план. Запись выполняется лишь с флагом --apply.
import { neon } from "@neondatabase/serverless";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const seedPath = path.join(scriptDir, "..", "src", "lib", "scripts", "b2g-seed.json");
const seed = JSON.parse(await readFile(seedPath, "utf8"));
const document = seed["1"];

if (!document || !Array.isArray(document.sections)) {
  throw new Error("В b2g-seed.json отсутствует корректный скрипт линии 1");
}

const blockCount = document.sections.reduce(
  (sum, section) => sum + (Array.isArray(section.items) ? section.items.length : 0),
  0,
);
const apply = process.argv.includes("--apply");

console.log(`Источник: ${path.relative(process.cwd(), seedPath)}`);
console.log(`Будет синхронизировано: ${document.title}`);
console.log(`Разделов: ${document.sections.length}; блоков: ${blockCount}`);

if (!apply) {
  console.log("Предпросмотр завершён. Для записи в D1 повторите команду с флагом --apply.");
  process.exit(0);
}

if (!process.env.DATABASE_URL) {
  throw new Error("Для записи требуется DATABASE_URL. Скрипт не читает .env автоматически.");
}

const sql = neon(process.env.DATABASE_URL);
const content = {
  sections: document.sections,
  sourceDocument: document.source_document,
  sourceSheets: document.source_sheets,
  sourceVersion: "3.0",
  effectiveFrom: document.effective_from,
};

const existing = await sql`
  SELECT id, department, line, title, notion_url, content, version,
         updated_by, created_at, updated_at
  FROM scripts
  WHERE department = 'b2g' AND line = '1'
  ORDER BY id
  LIMIT 1;
`;

const backupDir = path.join(os.tmpdir(), "sternmeister-script-backups");
await mkdir(backupDir, { recursive: true });
const backupPath = path.join(
  backupDir,
  `b2g-line1-before-v3-${new Date().toISOString().replaceAll(":", "-")}.json`,
);
await writeFile(backupPath, `${JSON.stringify(existing[0] ?? null, null, 2)}\n`, "utf8");
console.log(`Резервная копия текущей записи: ${backupPath}`);

const result = existing[0]
  ? await sql`
      UPDATE scripts
      SET title = ${document.title},
          notion_url = ${document.notion_url ?? null},
          content = ${JSON.stringify(content)}::jsonb,
          version = version + 1,
          updated_by = 'repo-sync-v3.0',
          updated_at = NOW()
      WHERE id = ${existing[0].id}
      RETURNING id, department, line, title, version, updated_at;
    `
  : await sql`
      INSERT INTO scripts (department, line, title, notion_url, content, version, updated_by)
      VALUES (
        'b2g',
        '1',
        ${document.title},
        ${document.notion_url ?? null},
        ${JSON.stringify(content)}::jsonb,
        1,
        'repo-sync-v3.0'
      )
      RETURNING id, department, line, title, version, updated_at;
    `;

console.log("Синхронизация завершена:", result[0]);
