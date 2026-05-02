/**
 * generate-pg-comments.ts — Phase 0 of MCP server initiative.
 *
 * Emits per-DB SQL migrations that attach `COMMENT ON TABLE` / `COMMENT ON COLUMN`
 * statements to all canonical tables of all 6 dashboard databases. The output is
 * applied manually through Neon SQL editor (Neon HTTP driver times out on long
 * DDL batches). Independently useful: drizzle-studio + any psql client surface
 * the comments. Becomes the structural foundation that the MCP server's
 * curated tools rely on for table/column descriptions.
 *
 * SCOPE OF THIS RUN (Phase 0a — TABLE-level + curated COLUMN seeds):
 *   - Per-table descriptions extracted from docs/DASHBOARD-*.md → "Источники
 *     данных" sections + a "Used by tabs: …" suffix derived from the doc names.
 *   - Hand-curated TABLE_NARRATIVES override for tables that have no doc
 *     mention or whose mention is too thin (managers/manager_schedule/etc come
 *     from DASHBOARD-MANAGERS.md which uses a different layout).
 *   - Tables enumerated from src/lib/db/schema-{existing,okk,analytics,tracking}.ts.
 *   - Curated COLUMN_COMMENTS map for ~30 highest-value columns.
 *   - One SQL file per target DB, written under drizzle/<db>/.
 *
 * Phase 0b (extended COLUMN coverage) — incremental: append entries to
 * COLUMN_COMMENTS map as new tools surface columns that need narrative.
 *
 * USAGE:
 *   npx tsx scripts/generate-pg-comments.ts                   # write all SQL files
 *   npx tsx scripts/generate-pg-comments.ts --db=analytics    # single DB
 *   npx tsx scripts/generate-pg-comments.ts --dry-run         # print summary only
 *
 * OUTPUT LAYOUT (drizzle-kit ignores files outside drizzle/<dialect>/meta):
 *   drizzle/d1/0000_pg_comments.sql
 *   drizzle/r1/0000_pg_comments.sql
 *   drizzle/d2/0000_pg_comments.sql
 *   drizzle/r2/0000_pg_comments.sql
 *   drizzle/tracking/0000_pg_comments.sql
 *   drizzle/analytics/0012_pg_comments.sql   (continues existing 0000–0011 series)
 *
 * SAFETY:
 *   - Idempotent: COMMENT ON statements overwrite-or-noop. Re-applying is harmless.
 *   - Read-only relative to data; only catalog metadata changes.
 *   - Apply per-DB only after creating a Neon backup branch (feedback_db_caution).
 *   - All string literals escape via single-quote doubling. No user-supplied
 *     input reaches SQL — sources are static markdown + TS schema.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type DbTarget = "d1" | "r1" | "d2" | "r2" | "analytics" | "tracking";

interface TableSpec {
  /** Postgres-qualified name as it appears in DDL. */
  qualifiedName: string;
  /** Bare table name. */
  name: string;
  /** Column names declared in the Drizzle table(...) call. */
  columns: string[];
  /** Which physical DB(s) this table lives in. D2/R2 share a schema → emit to both. */
  targets: DbTarget[];
  /** Source schema file path (for diagnostics). */
  schemaFile: string;
}

interface DocsTableMention {
  /** Bare or qualified table name as written in the markdown row. */
  table: string;
  /** Narrative from the "Зачем нужна тут" cell. */
  narrative: string;
  /** Filename of the dashboard doc (e.g. "DASHBOARD-DAILY"). */
  doc: string;
}

interface MergedTableDoc {
  table: string;
  narrative: string;
  /** Sorted unique list of doc filenames for the "Used by tabs:" suffix. */
  mentionedIn: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI args
// ─────────────────────────────────────────────────────────────────────────────

interface Args {
  db?: DbTarget;
  dryRun: boolean;
}

const VALID_DBS: ReadonlyArray<DbTarget> = ["d1", "r1", "d2", "r2", "analytics", "tracking"];

function parseArgs(argv: string[]): Args {
  const args: Args = { dryRun: false };
  for (const a of argv) {
    if (a === "--dry-run") {
      args.dryRun = true;
    } else if (a.startsWith("--db=")) {
      const v = a.slice("--db=".length) as DbTarget;
      if (!VALID_DBS.includes(v)) {
        throw new Error(`Unknown --db=${v}. Valid: ${VALID_DBS.join(", ")}`);
      }
      args.db = v;
    } else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: tsx scripts/generate-pg-comments.ts [--db=<d1|r1|d2|r2|analytics|tracking>] [--dry-run]",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown arg: ${a}`);
    }
  }
  return args;
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 1 — Parse DASHBOARD-*.md → DocsTableMention[]
// ─────────────────────────────────────────────────────────────────────────────

const DOCS_DIR = "docs";
const DOC_FILE_GLOB = /^DASHBOARD-.+\.md$/;
const SECTION_HEADER_RE = /^##\s+Источники\s+данных\s*$/m;

async function loadDocsMentions(repoRoot: string): Promise<DocsTableMention[]> {
  const dir = path.join(repoRoot, DOCS_DIR);
  // Sort alphabetically so generator output is deterministic across OSes
  // (macOS APFS returns creation-order, Linux ext4 hash-order). Without sort,
  // mergeDocsMentions's "longest wins" rule could produce different SQL on
  // different machines from identical inputs.
  const entries = (await fs.readdir(dir)).sort();
  const mentions: DocsTableMention[] = [];
  for (const entry of entries) {
    if (!DOC_FILE_GLOB.test(entry)) continue;
    if (entry === "DASHBOARD-INDEX.md") continue; // index doc — not a per-tab source
    const docName = entry.replace(/\.md$/, "");
    const content = await fs.readFile(path.join(dir, entry), "utf8");
    const match = content.match(SECTION_HEADER_RE);
    if (!match || match.index === undefined) continue;
    const after = content.slice(match.index);
    const nextHeading = after.slice(1).search(/\n##\s+\S/);
    const slice = nextHeading >= 0 ? after.slice(0, nextHeading + 1) : after;
    for (const m of parseDocsTableRows(slice, docName)) {
      mentions.push(m);
    }
  }
  return mentions;
}

function parseDocsTableRows(slice: string, doc: string): DocsTableMention[] {
  const out: DocsTableMention[] = [];
  const lines = slice.split("\n");
  let inTable = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (/^\|\s*[-:]+\s*\|/.test(line)) {
      inTable = true; // separator row — data rows follow
      continue;
    }
    if (!line.startsWith("|")) {
      inTable = false;
      continue;
    }
    if (!inTable) continue;
    // Data row.
    const cells = line.split("|").slice(1, -1).map((s) => s.trim());
    if (cells.length < 3) continue;
    const tableCell = cells[1];
    const tableMatch = tableCell.match(/`([^`]+)`/);
    if (!tableMatch) continue;
    const table = tableMatch[1];
    // Skip non-table tokens that occasionally show up in code spans.
    if (!/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)?$/i.test(table)) continue;
    const narrative = stripTrailingPunct(cells[2]);
    if (!narrative) continue;
    out.push({ table, narrative, doc });
  }
  return out;
}

function stripTrailingPunct(s: string): string {
  return s.replace(/\s+$/, "").replace(/[.;]+$/, "");
}

function mergeDocsMentions(rows: DocsTableMention[]): Map<string, MergedTableDoc> {
  const merged = new Map<string, MergedTableDoc>();
  for (const r of rows) {
    const key = r.table;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { table: r.table, narrative: r.narrative, mentionedIn: [r.doc] });
    } else {
      // Longest narrative wins (deterministic). Caveat: if curated rich docs
      // and a terse-but-authoritative one disagree, terse loses — but in
      // practice the authoritative narrative ALSO lives in TABLE_NARRATIVES,
      // which overrides this map entirely.
      if (r.narrative.length > existing.narrative.length) {
        existing.narrative = r.narrative;
      }
      if (!existing.mentionedIn.includes(r.doc)) {
        existing.mentionedIn.push(r.doc);
        existing.mentionedIn.sort();
      }
    }
  }
  return merged;
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 2 — Hand-curated table narratives (overrides docs when present)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Tables that need richer narratives than what their DASHBOARD-*.md mentions
 * provide. Especially the master_managers cluster — DASHBOARD-MANAGERS.md
 * uses subsections instead of an "Источники данных" table, so auto-extraction
 * misses these. Also internal-only tables (kommo_tokens, bug_reports,
 * daily_snapshots, telephony_cdr) get explicit "internal — not surfaced in UI"
 * stubs so MCP/SQL grep'ers know to skip them.
 *
 * Key = bare table name. Hand-written narrative wins over auto-extracted.
 */
const TABLE_NARRATIVES: Record<string, string> = {
  // D1 — single-source-of-truth cluster
  master_managers:
    "Single source of truth для всех менеджеров обоих отделов (B2G + B2B). При сохранении синкается в D2.managers / R2.managers / D1.d1_users / R1.r1_users по флагам in_okk / in_rolevki. Soft-delete (is_active=false) сохраняет FK в исторических звонках. JOINs: → manager_schedule.user_id, → daily_plans.user_id, → manager_bonuses.user_id, → payroll_runs.user_id; sync targets D2.managers.id / R2.managers.id / D1.d1_users.id / R1.r1_users.id; Kommo via kommo_user_id ↔ analytics.leads_cohort.responsible_user_id.",
  manager_schedule:
    "Per-day расписание менеджера: что он делает в конкретный день (8/4/-/о/н/у). Драйвит is_on_line для Звонков и payrollFactor для Табеля. Один день = одна строка; пустые дни в БД отсутствуют.",
  payroll_runs:
    "Snapshot закрытого месяца Табеля: equiv_full_days × daily_rate + bonus_amount = gross_amount. Upsert по (department, period_month, user_id). Cron записывает 0 2 1 * * Europe/Berlin.",
  manager_bonuses:
    "Ручная ежемесячная премия менеджера (Табель popup). Один ряд на (user_id, period_month); удаляется при amount=0. Плюсуется к gross в payroll_runs.",
  daily_plans:
    "Сохранённые план-значения для Daily-метрик. Поддерживает 3 уровня: monthly → weekly → daily (cascade c пропорциональным делением если daily не задан). Edit-in-place карандашиком в UI.",
  scripts:
    "Канонические скрипты продаж по линиям/пайплайнам. JSONB content = { sections: [{ id, title, items: [...] }] }. Версионируется через увеличение `version`.",
  call_analyses:
    "Запросы на батч-анализ звонков по Kommo URL (Анализ tab). Прогресс отслеживается через progress / total_calls / processed_calls. resultSummary — Grok markdown итог.",
  call_analysis_files:
    "Файлы результата call_analyses (transcript / summary / index). cascade-delete вместе с parent analysis. callScore = Grok-assigned релевантность.",
  d1_users:
    "Ролевочные пользователи B2G (зеркало master_managers с in_rolevki=true). Линкуются по telegram_id. team='dima' для всех B2G.",
  d1_avatars: "AI-аватары роли клиента, используются в B2G ролевках. JSONB data описывает personality/scenarios.",
  d1_calls:
    "AI-ролевки B2G: транскрипт + JSONB evaluation (blocks/criteria/scores). score 0-100. user_id → d1_users; avatar_id → d1_avatars.",
  r1_users: "Ролевочные пользователи B2B (зеркало master_managers с in_rolevki=true, department='b2b'). team='ruzanna'.",
  r1_avatars: "AI-аватары для B2B ролевок (та же схема что d1_avatars, но физически в R1 БД).",
  r1_calls:
    "AI-ролевки B2B: та же схема что d1_calls. user_id → r1_users; avatar_id → r1_avatars.",
  // Internal / служебные — explicit stubs so MCP knows to skip
  kommo_tokens:
    "[INTERNAL] Кеш Kommo OAuth-токенов (access + refresh). Используется kommo/client.ts. Не для аналитических запросов.",
  bug_reports:
    "[INTERNAL] Сообщения «Сообщить об ошибке» из попапа дашборда; mirror в Discord. Не для аналитики.",
  daily_snapshots:
    "[LEGACY, deprecated 2026-04-24] Старый кеш Daily ответов. Может ещё читаться как fallback. Заменён analytics.* зеркалом.",
  // OKK служебные
  telephony_cdr:
    "[INTERNAL — OKK] Phase 2 webhook coverage tracking: сырой CDR для proof-of-coverage. Источник для phantom_history. Не для прямых запросов.",
  // OKK worst-calls (notification popup, не в основной выдаче)
  worst_calls:
    "Топ-N худших звонков менеджера за день/период. Drives WorstCallsPanel popup в ОКК-разделе + Telegram-уведомления (14:00/17:00). FK: call_id → calls.id, evaluation_id → evaluations.id, manager_id → managers.id.",
  // Tracking
  tracking_sync_state:
    "[INTERNAL — Tracking] Маркер последнего синка: cursor (last_event_ts), backfill watermark (earliest_event_ts), filter version. Используется ensureRangeCached.",
  // Analytics — overrides for tables whose docs-derived narrative contains
  // inline-code or list-style noise (better baseline for MCP curated tools).
  leads_cohort:
    "Когорта лидов: pipeline / status / manager / UTM / payment fields / termin dates / non_qual + b2b_close_reason enum_id. Single source-of-truth для Daily, Looker, Termin, Звонки. Заполняется ETL sync-leads.ts из Kommo /leads incremental по filter[updated_at]; closed/payment/termin поля резолвятся по name из custom_fields_values.",
  communications:
    "Все коммуникации лидов (звонки + сообщения). communication_type LIKE 'call%' для звонков. Источники: Kommo /notes (legacy 'note:N' до 2026-04-28 hard-split) + CallGear ('cg-leg:N') + CloudTalk ('ct:N'). Composite unique (communication_id, COALESCE(lead_id,0)) поддерживает Pattern A: один CDR → N rows (по числу matched лидов после enrich-telephony-leads).",
  lead_status_changes:
    "Переходы лидов между статусами Kommo. Используется для cohort-status, conversion view, qual-leads count, TERM_DC_DONE baseline в Termin.",
  sla:
    "Per-lead SLA метрики: first_call (BH/calendar/from-shift seconds), TLT (Time between Latest Touches), статус. *_integrator колонки — frozen snapshot интегратора на момент cutoff 2026-04-29; COALESCE(integrator, computed) для исторической parity. compute-sla.ts в ETL ничего не пишет в *_integrator.",
  tasks:
    "Per-lead Kommo-задачи: создание, дедлайн, completed_flg. Используется Daily для overdue tasks per manager.",
  // Analytics — служебные / резерв (не surfaced в UI)
  ads_report:
    "[RESERVE] Mirror интеграторской ads-таблицы (Yandex/Google ads + UTM-разрезы). Пока не подключено к UI — reserved for будущего рекламного отчёта.",
  sales_report:
    "[RESERVE] Mirror интеграторской sales-таблицы per-manager-per-day агрегатов (calls_cnt, success_calls, payment_sum, sales_plan, quality). Не подключено к UI; cross-check резерв.",
  custom_report:
    "[INTERNAL] Универсальная metric_name × dt таблица — copy интеграторской. Зеркало report_sternmeister_custom_report. Не используется в нашем UI; реплицируется для возможной обратной сверки с их Looker.",
  refusal_enums:
    "Кеш Kommo enum-options для custom-fields категории refusal. Известные field_id: 879824 «Причина закрытия Госники» (B2G non-qual), 876383 «B2B close reason» (Бух Комм 10631243 / Мед Комм 13209983, обязательное на статусе 143). enum_id → human-readable value. Заполняется ETL lookups; читается getRefusalReasons() для Daily refusals.",
  funnel:
    "[RESERVE] Зеркало report_sternmeister_funnel — operational metrics (dt_operational vs dt_cohort). Не surfaced в UI напрямую; cross-check с интегратором.",
};

// ─────────────────────────────────────────────────────────────────────────────
// Step 3 — Curated column-comment overrides (Phase 0b source of truth)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Hand-curated per-column descriptions. Seeded from MCP-IMPLEMENTATION-PLAN.md
 * §6.1 + DASHBOARD-OKK / DASHBOARD-LOOKER / DASHBOARD-MANAGERS "Ключевые
 * колонки" cells. New entries land here when a column shows up in a tool's
 * outputSchema and lacks a comment.
 *
 * Key format: "<bare_table>.<column>".
 */
const COLUMN_COMMENTS: Record<string, string> = {
  // master_managers (D1)
  "master_managers.role":
    "'manager' | 'rop' | 'admin'. ROP с непустой line одновременно работает на линии (double-status, см. project_double_status memory).",
  "master_managers.line":
    "B2G линия: '1'=квалификатор, '2'=бератер, '3'=доведение. NULL для B2B и для ROP без линии.",
  "master_managers.team":
    "'dima' (B2G) | 'ruzanna' (B2B). Дублирует department, оставлен для совместимости с d1_users/r1_users.",
  "master_managers.department": "'b2g' | 'b2b'. Драйвит роутинг в OKK/ролевочные БД.",
  "master_managers.kommo_user_id":
    "ID пользователя в Kommo CRM. Резолвится автоматом по имени при сохранении менеджера.",
  "master_managers.callgear_employee_id":
    "ID агента в CallGear. Используется sync-telephony.ts для атрибуции звонков.",
  "master_managers.cloudtalk_agent_id":
    "ID агента в CloudTalk. Аналогично callgear_employee_id.",
  "master_managers.in_okk":
    "true → менеджер синкается в managers таблицу OKK-БД (D2/R2) при сохранении.",
  "master_managers.in_rolevki":
    "true (и telegram_id IS NOT NULL) → синкается в d1_users/r1_users.",
  "master_managers.is_active":
    "Soft-delete флаг. FALSE сохраняет FK-связи с историческими звонками; UI скрывает строку.",
  "master_managers.daily_rate":
    "Дневная ставка для Табеля. Drizzle numeric → string на чтение (parseFloat). Currency project-wide.",
  "master_managers.shift_start_time": "'HH:MM' начало смены (NULL = дефолт 09:00). Per-day override живёт в manager_schedule.",
  "master_managers.shift_end_time": "'HH:MM' конец смены (NULL = дефолт 18:00). Per-day override в manager_schedule.",

  // manager_schedule
  "manager_schedule.schedule_value":
    "Канонический код дня: '8' (полный), '4' (половина), '-' (выходной), 'о' (отпуск), 'н' (онбординг), 'у' (день увольнения). См. SCHEDULE_STATUSES в schedule-payroll.ts.",
  "manager_schedule.is_on_line":
    "Derived из schedule_value: '-'/'о' → false, остальные → true. Драйвит фильтрацию Звонков и SLA-окна.",
  "manager_schedule.schedule_date": "'YYYY-MM-DD' civil-date в Europe/Berlin.",

  // payroll_runs
  "payroll_runs.status_breakdown":
    "JSONB { '8': 18, '4': 2, 'о': 5, ... } — счётчики дней по канонам. Snapshot, не пересчитывается.",
  "payroll_runs.equiv_full_days":
    "Σ count[code] × payrollFactor[code]. Snapshot.",
  "payroll_runs.gross_amount":
    "= equiv_full_days × daily_rate + bonus_amount. Frozen на момент cron-записи.",
  "payroll_runs.bonus_amount":
    "Snapshot manager_bonuses.amount на момент cron. Включён в gross_amount.",

  // okk.evaluations (D2/R2)
  "evaluations.total_score":
    "Итоговый балл оценки (0-100). NULL → оценка не завершена; UI/MCP такие звонки прячут.",
  "evaluations.evaluation_json":
    "Полная структура оценки: { blocks[], total_score, total_max_score, summary, client_scoring }. Каждый block: { name, score|block_score, max_score|max_block_score, criteria[] }, каждый criterion: { name, score, max_score, feedback, quote? }. Поддерживает legacy (score/max_score) и новый (block_score/max_block_score) форматы.",
  "evaluations.override_metadata":
    "JSON метаданные программных корректировок AI-оценки. Ключи: is_followup, followup_signal_source (lead_id|phone_fallback|phone_fallback_no_crm|null), prior_count, call_type (primary|followup|interrupted|unqualified|transfer|deferred_start|unknown), overrides_applied (массив правил), score_before_override, score_after_override.",
  "evaluations.call_number":
    "Порядковый номер звонка менеджера в этой OKK-БД (D1, D2, ...) — не FK, локальный счётчик OKK.",
  "evaluations.prompt_type":
    "Тип промпта (определяет каноничный набор блоков/критериев). Используется Аналитикой для группировки.",

  // okk.calls (D2/R2)
  "calls.direction":
    "'inbound' | 'outbound'. Драйвит speaker labelling: outbound → Speaker A = клиент; inbound → Speaker A = менеджер. NULL → raw labels.",
  "calls.transcript_speakers":
    "JSONB массив сегментов { speaker, text, start, end }. NULL на старых звонках — UI fall-back на plain transcript.",
  "calls.status":
    "'pending' | 'evaluated' | 'error'. UI/MCP показывают только evaluated.",
  "calls.contact_phone":
    "PII: телефон контакта. MCP маскирует до '+7***1234' независимо от роли (см. utils/pii.ts когда landed).",
  "calls.kommo_lead_url":
    "Полный URL лида в Kommo. Используется UI для deep-link.",

  // okk.managers (D2/R2)
  "managers.line":
    "B2G линия: '1'=квалификатор, '2'=бератер, '3'=доведение. ROP с непустой line — double-status, включается как линейный.",
  "managers.role": "'manager' | 'rop' | 'admin'. ROP с непустой line — линейный сотрудник.",
  "managers.is_active": "Soft-delete (синкается из master_managers.is_active).",

  // okk.phantom_history
  "phantom_history.coverage_pct":
    "% звонков менеджера из telephony_cdr, которые попали в OKK calls на этот день. Heatmap в Аудит-tab.",
  "phantom_history.phantom_count":
    "Кол-во CDR-звонков, не попавших в OKK (= не оценённых, например короткие <10s).",

  // analytics.communications
  "communications.communication_type":
    "Префикс источника: 'call_*' (звонок), 'note' (текст), 'message_*' (мессенджер). MCP/Looker фильтруют LIKE 'call%'.",
  "communications.communication_id":
    "Уникальный ID источника: 'note:N' (Kommo notes — устарело после hard-split 2026-04-28), 'cg-leg:N' (CallGear leg), 'ct:N' (CloudTalk). Composite unique с COALESCE(lead_id,0) — Pattern A позволяет один CDR → N rows (по числу matched лидов).",
  "communications.phone":
    "Номер с PBX (CallGear/CloudTalk). NULL → строка пришла из Kommo notes. Используется enrich-telephony-leads ETL для резолва lead_id.",
  "communications.pipeline_id":
    "Kommo pipeline. NULL до прохода enrich-telephony-leads (телефонные строки приходят без линка на лида).",
  "communications.duration":
    "Длительность звонка в секундах. NULL для не-call записей.",
  "communications.first_contact_flg":
    "smallint 0/1 — это первый контакт лида с менеджером. Используется Looker для cohort SLA.",
  "communications.last_contact_flg":
    "smallint 0/1 — это последний контакт. TLT использует для разрезания истории.",

  // analytics.leads_cohort
  "leads_cohort.first_payment_date":
    "Дата первой оплаты лида (Kommo custom field, B2B-pipelines). Драйвит Daily Commerce R24 секции «Продажи».",
  "leads_cohort.prepayment_date":
    "Дата предоплаты лида (Kommo custom field, B2B). Аналог first_payment_date для предоплаты.",
  "leads_cohort.first_payment_amount":
    "Сумма первой оплаты (B2B). NULL до факта оплаты.",
  "leads_cohort.prepayment_amount":
    "Сумма предоплаты (B2B). NULL до факта.",
  "leads_cohort.b2b_close_reason_enum_id":
    "B2B причина закрытия (Kommo enum). Используется для SLA gate: 740587=Неквал, 740593=Спам, 740595=Сотрудничество — дроп пары лид-call из average. Только pipeline 10631243/13209983.",
  "leads_cohort.non_qual_enum_id":
    "B2G причина неквалификации (Kommo enum 879824). enum_ids: 744486=Неправильный номер, 744876/747530/747532/747534/747536=Неквал.*. Заполняет refusals секцию Daily.",
  "leads_cohort.termin_date":
    "Custom field 'Дата термина ДЦ' / 'Дата термина' (B2G Бух Бератер). Drives Termin tab cohort chart. Резолв по name (не Kommo ID — он плавает per-lead).",
  "leads_cohort.aa_termin_date":
    "Custom field 'Дата термина АА' (B2G). Baseline switches to MIN(event_at WHERE status_id=TERM_DC_DONE 93886075) when present, else falls back to created_at.",
  "leads_cohort.responsible_user_id":
    "Kommo user ID ответственного менеджера. JOIN с master_managers.kommo_user_id для resolved name.",

  // analytics.sla
  "sla.sla_first_call_seconds":
    "BH-time от создания лида до первого outbound-звонка ОТВЕТСТВЕННОГО менеджера. NULL когда: (а) ни одного outbound-звонка вообще, ИЛИ (б) outbound-звонки были, но не от responsible. Inbound-звонки игнорируются.",
  "sla.sla_first_call_calendar_seconds":
    "Calendar-time (без BH adjustment) — для оптимистичных метрик и cross-check с интегратором.",
  "sla.sla_first_call_from_shift_seconds":
    "Время от начала смены ответственного менеджера в day-of-call (учитывает manager_schedule).",
  "sla.tlt_seconds":
    "Time between Latest Touches: BH-time между двумя последними outbound-звонками. NULL когда у менеджера 0–1 звонок на лиде.",
  "sla.sla_first_call_seconds_integrator":
    "Snapshot значения интегратора на момент cutoff 2026-04-29 (commit 81ce2c8). COALESCE(integrator_col, computed_col) — исторические лиды совпадают с интеграторским дашбордом, новые с нашим compute.",
  "sla.tlt_integrator":
    "Аналог sla_first_call_seconds_integrator для TLT. Frozen mirror.",

  // tracking_events (Tracking DB)
  "tracking_events.event_type":
    "Kommo event type, normalized. 41 verified-firing типов после v9 audit (2026-04-28). Группы: outgoing_call, incoming_call, lead_added, lead_status_changed, custom_field_*_value_changed, entity_*, task_*, note_*.",
  "tracking_events.duration_sec":
    "Resolved для звонков (из call note params), 0 для всех остальных событий.",
  "tracking_events.raw":
    "Original event payload (минимальный). С v10 содержит full Kommo call params: uniq, pbx_source, link, phone, call_status, call_result.",
  "tracking_events.created_at":
    "Время события в Kommo (UTC, конвертится в Europe/Berlin при рендере).",
  "tracking_events.entity_id":
    "Kommo entity.id (lead/contact/company/customer/unsorted в зависимости от entity_type). Для entity_type='lead' это JOIN-ключ к analytics.leads_cohort.lead_id и okk.calls.kommo_lead_id.",
  "tracking_events.entity_type":
    "'lead' | 'contact' | 'company' | 'customer' | 'unsorted'. Драйвит интерпретацию entity_id.",
  "tracking_events.manager_id":
    "master_managers.id (UUID stored as text — cross-DB JOIN).",

  // analytics.leads_cohort — additional critical columns (review HIGH)
  "leads_cohort.status_id":
    "Kommo status_id текущего статуса лида. Известные ID: 93886075=TERM_DC_DONE (B2G ДЦ-термин). См. lead_status_changes для истории переходов.",
  "leads_cohort.pipeline_id":
    "Kommo pipeline_id. B2B-пайплайны: 10631243=Бух Комм, 13209983=Мед Комм (используются в b2b_close_reason gate). B2G — отдельный набор; 12154099=Бух Бератер (Termin tab). См. docs/DASHBOARD-DAILY.md.",
  "leads_cohort.lead_id":
    "Kommo lead.id. PK когорты. ← lead_status_changes.lead_id, ← communications.lead_id, ← sla.lead_id, ← tasks.lead_id. Также tracking_events.entity_id (where entity_type='lead') и okk.calls.kommo_lead_id.",
  "leads_cohort.manager":
    "Имя ответственного менеджера строкой. WARN: known name-drift с master_managers.name (Maksim/Latin-C/Ukrainian-Є) — JOIN через alias-таблицу в src/lib/daily/name-aliases.ts, не прямо.",
  "leads_cohort.responsible_user_id":
    "Kommo user ID ответственного менеджера. JOIN с master_managers.kommo_user_id для resolved name (минует name-drift).",

  // analytics.communications — JOIN keys (review CRITICAL)
  "communications.lead_id":
    "Kommo lead.id после enrich-telephony-leads. NULL → телефонный leg не сматчился ни с одним лидом. Composite UNIQUE(communication_id, COALESCE(lead_id,0)) → никогда не JOIN-ить только по communication_id.",
  "communications.manager":
    "Имя менеджера строкой как у интегратора. WARN: 3 known name-drifts vs master_managers.name (Maksim/Latin-C/Ukrainian-Є) — JOIN через alias-таблицу в src/lib/daily/name-aliases.ts. См. project_analytics_name_aliases memory.",
  "communications.first_call_at":
    "Время первого звонка по этому лиду (denormalized из CDR). Используется Looker для cohort SLA.",
  "communications.entity_id":
    "Kommo entity.id (lead/contact/company), на котором висит коммуникация.",

  // analytics.sla — gaps from review
  "sla.sla_status":
    "Категориальный SLA-статус: 'green' (≤9 мин) | 'yellow' (10–29 мин) | 'red' (≥30 мин) | NULL (звонка не было).",
  "sla.first_call_out_at":
    "Время первого outbound-звонка ответственного менеджера. Драйвит sla_first_call_seconds. NULL ↔ звонка не было ИЛИ был только inbound.",
  "sla.lead_id":
    "Kommo lead.id. PK SLA-таблицы (один ряд = один лид). JOIN с leads_cohort, communications, lead_status_changes, tasks.",

  // analytics.tasks
  "tasks.lead_id":
    "Kommo lead.id, на котором висит задача.",
  "tasks.is_completed":
    "smallint 0/1. Daily overdue tasks = is_completed=0 AND deadline < NOW().",
  "tasks.deadline":
    "Дедлайн задачи (UTC). Используется для overdue-фильтра.",

  // okk.calls — JOIN keys (review CRITICAL)
  "calls.kommo_lead_id":
    "Kommo lead.id. JOIN-ключ в analytics.leads_cohort.lead_id и tracking_events.entity_id (entity_type='lead'). NULL → звонок не привязан к лиду (orphan, UI скрывает).",
  "calls.manager_id":
    "FK → managers.id (UUID, OKK-локальный). NULL → orphan; UI/MCP такие звонки скрывают.",
  "calls.duration_seconds":
    "Длительность звонка. Только evaluated calls с длительностью ≥10s попадают в OKK; короткие фильтруются.",

  // okk.evaluations
  "evaluations.call_id":
    "FK → calls.id. 1:1 — один evaluation на звонок.",
  "evaluations.manager_id":
    "FK → managers.id. Дублирует calls.manager_id для прямых per-manager агрегаций без JOIN.",

  // okk.worst_calls
  "worst_calls.call_id":
    "FK → calls.id. Какой именно звонок попал в топ-N худших.",
  "worst_calls.evaluation_id":
    "FK → evaluations.id (snapshot оценки на момент включения в worst).",
  "worst_calls.period":
    "'morning' | 'afternoon' — слот уведомления (14:00 / 17:00 Europe/Berlin).",
  "worst_calls.responded":
    "Менеджер ответил голосом на уведомление. Драйвит response_adequate (после Grok adequacy check).",

  // okk.managers
  "managers.kommo_user_id":
    "Kommo user ID. Резолвится из master_managers.kommo_user_id при синке.",

  // okk.phantom_history
  "phantom_history.date":
    "Civil-date в Europe/Berlin. PK (department, manager_id, date).",
};

// ─────────────────────────────────────────────────────────────────────────────
// Step 4 — Parse Drizzle schema files into TableSpec[]
// ─────────────────────────────────────────────────────────────────────────────

const SCHEMA_FILES = [
  "src/lib/db/schema-existing.ts",
  "src/lib/db/schema-okk.ts",
  "src/lib/db/schema-analytics.ts",
  "src/lib/db/schema-tracking.ts",
] as const;

/**
 * Match: `pgTable("name", {...}` OR `<schema>Schema.table("name", {...}`.
 * Capture group 1 = bare table name. Anchor on whitespace-or-punct before
 * the call expression so `<word>.table(` doesn't grab unrelated calls.
 */
const TABLE_DECL_RE = /(?:pgTable|\w+Schema\.table)\(\s*"([^"]+)"\s*,\s*\{/g;

/**
 * Match a column declaration line within the body brace: `colName: typeFn(`.
 * Anchored on indent, requires `: <ident>(` to avoid matching object keys
 * that aren't column declarations.
 */
const COLUMN_DECL_RE = /^\s+(\w+):\s+(?:\w+\.)?\w+\(/gm;

async function parseSchemas(repoRoot: string): Promise<TableSpec[]> {
  const out: TableSpec[] = [];
  for (const rel of SCHEMA_FILES) {
    const abs = path.join(repoRoot, rel);
    const content = await fs.readFile(abs, "utf8");
    for (const spec of parseSchemaFile(content, rel)) {
      out.push(spec);
    }
  }
  return out;
}

function parseSchemaFile(content: string, schemaFile: string): TableSpec[] {
  const out: TableSpec[] = [];
  let m: RegExpExecArray | null;
  TABLE_DECL_RE.lastIndex = 0;
  while ((m = TABLE_DECL_RE.exec(content)) !== null) {
    const tableName = m[1];
    // Body starts at the `{` we matched. Find matching `}` by brace counting.
    const bodyStart = m.index + m[0].length - 1; // points at opening `{`
    const bodyEnd = findMatchingBrace(content, bodyStart);
    if (bodyEnd === -1) {
      console.warn(`[warn] could not find matching brace for ${tableName} in ${schemaFile}`);
      continue;
    }
    const body = content.slice(bodyStart + 1, bodyEnd);
    const columns = extractColumnNames(body);
    const targets = computeTargets(schemaFile, tableName);
    const qualifiedName =
      schemaFile.endsWith("schema-analytics.ts")
        ? `analytics.${tableName}`
        : `public.${tableName}`;
    out.push({ qualifiedName, name: tableName, columns, targets, schemaFile });
  }
  return out;
}

/**
 * Walks `s` from `openIdx` (must point at `{`) and returns index of the
 * matching `}` accounting for string literals and comments.
 *
 * KNOWN LIMITATION: does NOT track `${ ... }` interpolation inside template
 * literals. If a column body ever introduces a default value via template
 * literal with interpolation (e.g. `.$default(() => `${x}`)`), the `}` of
 * the interpolation will decrement depth incorrectly. None of the current
 * schemas exercise this — Drizzle defaults are usually `.$defaultFn(...)`
 * with object literals, not template strings. If this constraint becomes
 * limiting, switch to a real TS AST parser (ts-morph / typescript compiler
 * API) instead of regex.
 */
function findMatchingBrace(s: string, openIdx: number): number {
  if (s[openIdx] !== "{") return -1;
  let depth = 0;
  let inString: '"' | "'" | "`" | null = null;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = openIdx; i < s.length; i++) {
    const ch = s[i];
    const next = s[i + 1];
    if (inLineComment) {
      if (ch === "\n") inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === "/" && next === "/") {
      inLineComment = true;
      i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function extractColumnNames(body: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  COLUMN_DECL_RE.lastIndex = 0;
  while ((m = COLUMN_DECL_RE.exec(body)) !== null) {
    // Body text — check that match is at top level (no nested braces between
    // body start and this match position).
    if (depthAt(body, m.index) !== 0) continue;
    const camel = m[1];
    if (seen.has(camel)) continue;
    seen.add(camel);
    names.push(camel);
  }
  // Now translate camelCase TS names to snake_case Postgres column names.
  // Convention: every column declaration immediately follows the camel name
  // with `text("snake_case", …)` etc — extract the literal from the actual
  // call. Re-scan for `<camel>: <fn>("<sql>"` to map.
  const map = new Map<string, string>();
  const callRe = /^\s+(\w+):\s+(?:\w+\.)?\w+\(\s*"([^"]+)"/gm;
  let cm: RegExpExecArray | null;
  while ((cm = callRe.exec(body)) !== null) {
    if (depthAt(body, cm.index) !== 0) continue;
    map.set(cm[1], cm[2]);
  }
  return names.map((n) => map.get(n) ?? camelToSnake(n));
}

function depthAt(body: string, idx: number): number {
  let d = 0;
  let inString: '"' | "'" | "`" | null = null;
  for (let i = 0; i < idx; i++) {
    const ch = body[i];
    if (inString) {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      continue;
    }
    if (ch === "{") d++;
    else if (ch === "}") d--;
  }
  return d;
}

function camelToSnake(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

/**
 * Known D1-only shared tables in schema-existing.ts (no `d1_*` / `r1_*`
 * prefix). Anything else without prefix triggers a console.warn so a future
 * dev who adds a shared-by-design table doesn't get silent misrouting.
 */
const D1_SHARED_TABLES = new Set([
  "master_managers",
  "bug_reports",
  "daily_plans",
  "manager_schedule",
  "payroll_runs",
  "manager_bonuses",
  "kommo_tokens",
  "scripts",
  "daily_snapshots",
  "call_analyses",
  "call_analysis_files",
]);

function computeTargets(schemaFile: string, tableName: string): DbTarget[] {
  if (schemaFile.endsWith("schema-okk.ts")) return ["d2", "r2"];
  if (schemaFile.endsWith("schema-analytics.ts")) return ["analytics"];
  if (schemaFile.endsWith("schema-tracking.ts")) return ["tracking"];
  // schema-existing.ts:
  if (tableName.startsWith("d1_")) return ["d1"];
  if (tableName.startsWith("r1_")) return ["r1"];
  if (D1_SHARED_TABLES.has(tableName)) return ["d1"];
  console.warn(
    `[warn] unrecognised non-prefixed table in schema-existing.ts: ${tableName}. ` +
      `Defaulting to D1-only. If this table should also live in R1, add explicit handling in computeTargets.`,
  );
  return ["d1"];
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 5 — SQL emission
// ─────────────────────────────────────────────────────────────────────────────

const TARGETS: ReadonlyArray<{ db: DbTarget; outFile: string; header: string }> = [
  { db: "d1", outFile: "drizzle/d1/0000_pg_comments.sql", header: "D1 (B2G ролевки + master_managers + общие)" },
  { db: "r1", outFile: "drizzle/r1/0000_pg_comments.sql", header: "R1 (B2B ролевки)" },
  { db: "d2", outFile: "drizzle/d2/0000_pg_comments.sql", header: "D2 (B2G OKK)" },
  { db: "r2", outFile: "drizzle/r2/0000_pg_comments.sql", header: "R2 (B2B OKK)" },
  {
    db: "analytics",
    outFile: "drizzle/analytics/0012_pg_comments.sql",
    header: "Analytics (mirror интегратора, схема analytics.*)",
  },
  { db: "tracking", outFile: "drizzle/tracking/0000_pg_comments.sql", header: "Tracking (Kommo activity cache)" },
];

function escapeSqlLiteral(s: string): string {
  return s.replace(/'/g, "''");
}

const TAB_LABELS: Record<string, string> = {
  "DASHBOARD-AI-ROLEVKI": "AI Ролевки",
  "DASHBOARD-AKTIVNOST": "Активность",
  "DASHBOARD-ANALITIKA": "Аналитика",
  "DASHBOARD-ANALIZ": "Анализ",
  "DASHBOARD-AUDIT": "Аудит",
  "DASHBOARD-DAILY": "Дейли",
  "DASHBOARD-KRITERII": "Критерии",
  "DASHBOARD-LOOKER": "Looker",
  "DASHBOARD-MANAGERS": "Менеджеры",
  "DASHBOARD-OKK": "ОКК",
  "DASHBOARD-SKRIPTY": "Скрипты",
  "DASHBOARD-TERMIN": "Термин",
  "DASHBOARD-ZVONKI": "Звонки",
};

/**
 * Per-DB prefix for TABLE comments. Resolves the D2/R2 collision flagged by
 * the database-architect review: both share schema-okk.ts and got byte-
 * identical comments, leaving the agent unable to tell which department a
 * row belonged to. Also lets us swap B2G-line semantics for B2B-correct
 * copy in R2 (e.g. "B2B has no line conventions, line is always NULL").
 */
const DB_PREFIX: Record<DbTarget, string> = {
  d1: "[D1 / B2G + общее]",
  r1: "[R1 / B2B ролевки]",
  d2: "[D2 / B2G OKK]",
  r2: "[R2 / B2B OKK]",
  analytics: "[Analytics — mirror интегратора]",
  tracking: "[Tracking — Kommo activity cache]",
};

/**
 * Per-(db, column) overrides. Wins over COLUMN_COMMENTS for the same
 * spec.name when target matches. Used to give R2 (B2B) different semantics
 * for `managers.line` / `managers.role` than D2 (B2G).
 */
const COLUMN_COMMENTS_BY_TARGET: Record<DbTarget, Record<string, string>> = {
  d1: {},
  r1: {
    "r1_calls.score": "См. d1_calls.score (та же семантика, B2B ролевки).",
    "r1_users.telegram_id":
      "JOIN-ключ к master_managers.telegram_id (department='b2b'). UNIQUE.",
  },
  d2: {},
  r2: {
    "managers.line":
      "B2B не использует line-конвенцию — всегда NULL. (В D2 значение драйвит B2G линии 1=квалификатор, 2=бератер, 3=доведение.)",
    "managers.role":
      "'manager' | 'rop' | 'admin'. В B2B нет line, поэтому double-status (rop+line) тут не применяется — ROP это всегда не-линейный.",
  },
  analytics: {},
  tracking: {},
};

function resolveTableNarrative(
  spec: TableSpec,
  target: DbTarget,
  docs: Map<string, MergedTableDoc>,
): string | null {
  const curated = TABLE_NARRATIVES[spec.name];
  // Look up doc mention by either bare name or qualified name.
  const doc = docs.get(spec.name) ?? docs.get(spec.qualifiedName);
  const usedBy = doc?.mentionedIn
    .map((d) => TAB_LABELS[d] ?? d)
    .filter((label, i, arr) => arr.indexOf(label) === i)
    .join(", ");
  const base = curated ?? doc?.narrative;
  if (!base) return null;
  const trimmed = base.replace(/\s+$/, "");
  const sep = /[.!?]$/.test(trimmed) ? " " : ". ";
  const usedBySuffix = usedBy ? `${sep}Used by tabs: ${usedBy}.` : "";
  const prefix = `${DB_PREFIX[target]} `;
  return prefix + trimmed + usedBySuffix;
}

function buildTableComment(
  spec: TableSpec,
  target: DbTarget,
  docs: Map<string, MergedTableDoc>,
): string | null {
  const text = resolveTableNarrative(spec, target, docs);
  if (!text) return null;
  return `COMMENT ON TABLE ${spec.qualifiedName} IS '${escapeSqlLiteral(text)}';`;
}

function buildColumnComments(spec: TableSpec, target: DbTarget): string[] {
  const out: string[] = [];
  const targetOverrides = COLUMN_COMMENTS_BY_TARGET[target] ?? {};
  for (const col of spec.columns) {
    const key = `${spec.name}.${col}`;
    const text = targetOverrides[key] ?? COLUMN_COMMENTS[key];
    if (!text) continue;
    out.push(
      `COMMENT ON COLUMN ${spec.qualifiedName}.${col} IS '${escapeSqlLiteral(text)}';`,
    );
  }
  return out;
}

function emitMigrationFor(
  target: DbTarget,
  header: string,
  specs: TableSpec[],
  docs: Map<string, MergedTableDoc>,
): { sql: string; tableCount: number; columnCount: number; missing: string[] } {
  const sorted = [...specs].sort((a, b) => a.qualifiedName.localeCompare(b.qualifiedName));
  const lines: string[] = [];
  lines.push(`-- =====================================================================`);
  lines.push(`-- pg COMMENTS — ${header}`);
  lines.push(`-- Generated by scripts/generate-pg-comments.ts (do NOT hand-edit).`);
  lines.push(`-- Source: docs/DASHBOARD-*.md (Источники данных) + src/lib/db/schema-*.ts.`);
  lines.push(`-- Apply via Neon SQL editor (HTTP timeout-safe). Idempotent.`);
  lines.push(`-- =====================================================================`);
  lines.push("");
  lines.push("BEGIN;");
  lines.push("");
  let tableCount = 0;
  let columnCount = 0;
  const missing: string[] = [];
  for (const spec of sorted) {
    const tableLine = buildTableComment(spec, target, docs);
    const columnLines = buildColumnComments(spec, target);
    if (!tableLine && columnLines.length === 0) {
      missing.push(spec.qualifiedName);
      continue;
    }
    lines.push(`-- ─── ${spec.qualifiedName} ───`);
    if (tableLine) {
      lines.push(tableLine);
      tableCount++;
    } else {
      missing.push(spec.qualifiedName);
    }
    for (const cl of columnLines) {
      lines.push(cl);
      columnCount++;
    }
    lines.push("");
  }
  lines.push("COMMIT;");
  lines.push("");
  return { sql: lines.join("\n"), tableCount, columnCount, missing };
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 6 — Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
  const args = parseArgs(process.argv.slice(2));

  const docsRows = await loadDocsMentions(repoRoot);
  const docs = mergeDocsMentions(docsRows);
  const specs = await parseSchemas(repoRoot);

  console.log(
    `[parse] ${docsRows.length} doc-row mentions across ${docs.size} unique tables; ${specs.length} table specs from schema.`,
  );

  // Schema-drift self-test: every key in COLUMN_COMMENTS / COLUMN_COMMENTS_BY_TARGET
  // must reference a column that actually exists in the parsed TableSpec[].
  // Catches stale entries (column rename, typo) BEFORE they fail at apply time
  // with `ERROR: column "x" of relation "y" does not exist`.
  validateColumnCommentKeys(specs);

  // Group specs by target. D2/R2 specs duplicate (same schema-okk.ts → both).
  const byTarget = new Map<DbTarget, TableSpec[]>();
  for (const spec of specs) {
    for (const t of spec.targets) {
      const list = byTarget.get(t) ?? [];
      list.push(spec);
      byTarget.set(t, list);
    }
  }

  let totalTables = 0;
  let totalColumns = 0;
  const allMissing: string[] = [];

  for (const { db, outFile, header } of TARGETS) {
    if (args.db && db !== args.db) continue;
    const list = byTarget.get(db) ?? [];
    if (!list.length) {
      console.warn(`[warn] no specs for ${db}`);
      continue;
    }
    const result = emitMigrationFor(db, header, list, docs);
    totalTables += result.tableCount;
    totalColumns += result.columnCount;
    if (result.missing.length) {
      allMissing.push(...result.missing.map((q) => `${db}:${q}`));
    }
    if (args.dryRun) {
      console.log(
        `--- ${outFile} — ${list.length} specs, ${result.tableCount} TABLE comments, ${result.columnCount} COLUMN comments ---`,
      );
      console.log(result.sql);
      continue;
    }
    const abs = path.join(repoRoot, outFile);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, result.sql, "utf8");
    console.log(
      `[write] ${outFile} — ${list.length} specs, ${result.tableCount} TABLE comments, ${result.columnCount} COLUMN comments`,
    );
  }

  if (allMissing.length) {
    console.warn(
      `[warn] ${allMissing.length} (db, table) entries got no TABLE comment (no doc mention + no curated narrative):\n  ` +
        allMissing.join("\n  "),
    );
  }
  console.log(`[done] total: ${totalTables} TABLE + ${totalColumns} COLUMN comments emitted.`);
}

function validateColumnCommentKeys(specs: TableSpec[]): void {
  // Build (table → Set<column>) index from parsed specs.
  const known = new Map<string, Set<string>>();
  for (const spec of specs) {
    const set = known.get(spec.name) ?? new Set<string>();
    for (const c of spec.columns) set.add(c);
    known.set(spec.name, set);
  }
  const stale: string[] = [];
  const checkKey = (key: string, where: string) => {
    const dot = key.indexOf(".");
    if (dot < 0) return;
    const t = key.slice(0, dot);
    const c = key.slice(dot + 1);
    const cols = known.get(t);
    if (!cols) {
      stale.push(`${where} → ${key} (table not found)`);
    } else if (!cols.has(c)) {
      stale.push(`${where} → ${key} (column not found)`);
    }
  };
  for (const k of Object.keys(COLUMN_COMMENTS)) checkKey(k, "COLUMN_COMMENTS");
  for (const [t, m] of Object.entries(COLUMN_COMMENTS_BY_TARGET)) {
    for (const k of Object.keys(m)) checkKey(k, `COLUMN_COMMENTS_BY_TARGET[${t}]`);
  }
  if (stale.length) {
    console.error(
      `[error] ${stale.length} COLUMN_COMMENTS keys reference unknown tables/columns:\n  ` +
        stale.join("\n  "),
    );
    process.exit(2);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
