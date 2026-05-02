/**
 * analiz.* — раздел "Анализ" дашборда. Батч-анализ звонков по Kommo URL
 * через Grok summarisation. Источник: D1.call_analyses + call_analysis_files.
 *
 * Phase 3c scope (2 tools):
 *   - analiz.list — список запросов на анализ за период / dept
 *   - analiz.get — детали одного запроса + файлы
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { z } from "zod";

import { d1, dashSchema } from "../../db/connections.js";
import { registerTool } from "../../registry/builder.js";

const { callAnalyses, callAnalysisFiles } = dashSchema;

const Dept = z.enum(["b2g", "b2b"]);

export function registerAnalizDomain(server: McpServer): void {
  registerTool(server, {
    name: "analiz.list",
    description: `Список запросов на анализ звонков за последние N дней (по умолчанию 14). Возвращает базовые поля без файлов: id, kommo_url, mode, status, progress, totalCalls, processedCalls, createdBy, created_at.`,
    inputShape: {
      dept: Dept,
      days: z.number().int().min(1).max(90).default(14),
      status: z.enum(["pending", "processing", "done", "error"]).optional(),
    },
    policy: {},
    deptArg: ({ dept }) => dept,
    handler: async ({ dept, days, status }) => {
      const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      const conds = [eq(callAnalyses.department, dept), gte(callAnalyses.createdAt, cutoff)];
      if (status) conds.push(eq(callAnalyses.status, status));
      const rows = await d1
        .select({
          id: callAnalyses.id,
          kommo_url: callAnalyses.kommoUrl,
          mode: callAnalyses.mode,
          status: callAnalyses.status,
          progress: callAnalyses.progress,
          total_calls: callAnalyses.totalCalls,
          processed_calls: callAnalyses.processedCalls,
          error_message: callAnalyses.errorMessage,
          created_by: callAnalyses.createdBy,
          created_at: callAnalyses.createdAt,
          expires_at: callAnalyses.expiresAt,
        })
        .from(callAnalyses)
        .where(and(...conds))
        .orderBy(desc(callAnalyses.createdAt))
        .limit(50);
      return { dept, days, status: status ?? "all", count: rows.length, rows };
    },
  });

  registerTool(server, {
    name: "analiz.get",
    description: `Детали одного запроса на анализ + результат summary + список файлов (без content для размеров — load file через analiz.get_file Phase 4).`,
    inputShape: {
      id: z.string().uuid(),
    },
    policy: {},
    handler: async ({ id }) => {
      // Explicit projection — guard against future internal columns leaking
      // (raw webhook payloads, API keys) to the agent context.
      const a = await d1
        .select({
          id: callAnalyses.id,
          department: callAnalyses.department,
          kommo_url: callAnalyses.kommoUrl,
          mode: callAnalyses.mode,
          status: callAnalyses.status,
          progress: callAnalyses.progress,
          total_calls: callAnalyses.totalCalls,
          processed_calls: callAnalyses.processedCalls,
          error_message: callAnalyses.errorMessage,
          result_summary: callAnalyses.resultSummary,
          created_by: callAnalyses.createdBy,
          created_at: callAnalyses.createdAt,
          expires_at: callAnalyses.expiresAt,
        })
        .from(callAnalyses)
        .where(eq(callAnalyses.id, id))
        .limit(1);
      if (a.length === 0) return { error: `analiz not found: ${id}` };
      const files = await d1
        .select({
          id: callAnalysisFiles.id,
          filename: callAnalysisFiles.filename,
          file_type: callAnalysisFiles.fileType,
          lead_id: callAnalysisFiles.leadId,
          call_score: callAnalysisFiles.callScore,
          created_at: callAnalysisFiles.createdAt,
          content_chars: sql<number>`length(${callAnalysisFiles.content})`,
        })
        .from(callAnalysisFiles)
        .where(eq(callAnalysisFiles.analysisId, id))
        .orderBy(desc(callAnalysisFiles.callScore));
      return {
        analiz: a[0],
        files_count: files.length,
        files,
      };
    },
  });
}
