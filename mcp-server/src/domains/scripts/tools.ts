/**
 * scripts.* — раздел "Скрипты" дашборда. Канонические скрипты продаж по
 * линиям и пайплайнам. Источник: D1.scripts (jsonb content + version).
 *
 * Phase 3c scope (2 tools):
 *   - scripts.list — каталог скриптов (без content)
 *   - scripts.get — content одного скрипта
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { d1, dashSchema } from "../../db/connections.js";
import { registerTool } from "../../registry/builder.js";

const { scripts } = dashSchema;

const Dept = z.enum(["b2g", "b2b"]);
const Line = z.enum(["1", "2", "3", "buh1", "buh2", "med1"]);

export function registerScriptsDomain(server: McpServer): void {
  registerTool(server, {
    name: "scripts.list",
    description: `Список всех скриптов отдела (без content для краткости): id, line, title, version, updated_at. Используй ДО scripts.get чтобы увидеть какой скрипт есть.`,
    inputShape: {
      dept: Dept,
    },
    policy: {},
    deptArg: ({ dept }) => dept,
    handler: async ({ dept }) => {
      const rows = await d1
        .select({
          id: scripts.id,
          line: scripts.line,
          title: scripts.title,
          notion_url: scripts.notionUrl,
          version: scripts.version,
          updated_by: scripts.updatedBy,
          updated_at: scripts.updatedAt,
        })
        .from(scripts)
        .where(eq(scripts.department, dept))
        .orderBy(scripts.line, desc(scripts.version));
      return { dept, count: rows.length, rows };
    },
  });

  registerTool(server, {
    name: "scripts.get",
    description: `Полный контент одного скрипта (jsonb content = { sections: [{ id, title, items: [...] }] }). Принимает id (int) или (dept, line) — последняя версия.`,
    inputShape: {
      dept: Dept.optional(),
      line: Line.optional(),
      id: z.number().int().positive().optional(),
    },
    policy: {},
    deptArg: (args) => args.dept as "b2g" | "b2b" | undefined,
    handler: async ({ dept, line, id }) => {
      if (id === undefined && (dept === undefined || line === undefined)) {
        return { error: "Pass either id, or both dept+line" };
      }
      let result;
      if (typeof id === "number") {
        result = await d1.select().from(scripts).where(eq(scripts.id, id)).limit(1);
      } else {
        result = await d1
          .select()
          .from(scripts)
          .where(and(eq(scripts.department, dept!), eq(scripts.line, line!)))
          .orderBy(desc(scripts.version))
          .limit(1);
      }
      if (result.length === 0) return { error: "Script not found" };
      return result[0]!;
    },
  });
}
