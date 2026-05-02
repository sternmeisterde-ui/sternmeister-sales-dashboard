/**
 * Discovery layer — agent's first 3 tool calls when it connects.
 *
 *   list_domains()              → catalog of available tool sets
 *   describe_domain(domain)     → detailed view of one domain (tools, key tables)
 *   glossary(term?)             → business term definitions
 *
 * All three are role/dept-agnostic (unauthed-OK in HTTP transport — they
 * leak no data, only schema metadata).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { registerTool } from "./builder.js";

interface DomainCatalogEntry {
  domain: string;
  summary: string;
  tool_count: number;
  /** Brief mention of which depts this domain serves. */
  scope: "b2g+b2b" | "b2g-only" | "b2b-only" | "internal";
  /** Tab(s) in the dashboard that consume the same data. */
  ui_counterpart: string;
}

const CATALOG: ReadonlyArray<DomainCatalogEntry> = [
  {
    domain: "managers",
    summary: "Поиск и сравнение менеджеров. master_managers — single source of truth для обоих отделов.",
    tool_count: 5,
    scope: "b2g+b2b",
    ui_counterpart: "Менеджеры",
  },
  {
    domain: "okk",
    summary: "Реальные оценённые звонки + аудит-метаданные. Источник: D2 (B2G) или R2 (B2B) OKK databases.",
    tool_count: 6,
    scope: "b2g+b2b",
    ui_counterpart: "ОКК + Аудит",
  },
  {
    domain: "daily",
    summary: "План-факт-отчёт + рефузалы. Phase 2b: список метрик + plan_vs_fact для известных + топ причин закрытия.",
    tool_count: 3,
    scope: "b2g+b2b",
    ui_counterpart: "Дейли",
  },
  {
    domain: "analytics",
    summary: "Аналитика AI-оценок (OKK + ролевки) по периодам, менеджерам, критериям.",
    tool_count: 3,
    scope: "b2g+b2b",
    ui_counterpart: "Аналитика",
  },
  {
    domain: "looker",
    summary: "Cohort SLA / звонки на лида / outliers. Упрощённый Looker tab без integrator-snapshot fallback.",
    tool_count: 3,
    scope: "b2g+b2b",
    ui_counterpart: "Looker",
  },
  {
    domain: "tracking",
    summary: "Активность менеджеров: workload, event breakdown, per-day timeline. Источник tracking_events (Kommo cache).",
    tool_count: 3,
    scope: "b2g+b2b",
    ui_counterpart: "Активность",
  },
  {
    domain: "termin",
    summary: "B2G Бух Бератер: cohort chart срока от лида до termin DC/AA.",
    tool_count: 1,
    scope: "b2g-only",
    ui_counterpart: "Термин",
  },
  {
    domain: "roleplay",
    summary: "AI-ролевки: тренировочные звонки с AI-аватарами клиентов. Avg score, find/compare к OKK, training_gaps.",
    tool_count: 4,
    scope: "b2g+b2b",
    ui_counterpart: "AI Ролевки",
  },
  {
    domain: "scripts",
    summary: "Канонические скрипты продаж по линиям и пайплайнам. List + get полного content (jsonb sections).",
    tool_count: 2,
    scope: "b2g+b2b",
    ui_counterpart: "Скрипты",
  },
  {
    domain: "analiz",
    summary: "Батч-анализ звонков по Kommo URL через Grok. List и detail (с files-summary). Phase 3c MVP — без full-content load.",
    tool_count: 2,
    scope: "b2g+b2b",
    ui_counterpart: "Анализ",
  },
  // Phase 4: criteria (FS-based), audit overlap with okk.audit_overrides
];

interface DomainDescription {
  domain: string;
  summary: string;
  scope: DomainCatalogEntry["scope"];
  tools: ReadonlyArray<{ name: string; verb: string; summary: string }>;
  key_tables: ReadonlyArray<string>;
  notes: string[];
}

const DESCRIPTIONS: Record<string, DomainDescription> = {
  managers: {
    domain: "managers",
    summary:
      "Менеджеры обоих отделов. master_managers (D1) — SoT; синкается в D2/R2 (OKK), D1.d1_users / R1.r1_users (ролевки).",
    scope: "b2g+b2b",
    tools: [
      { name: "managers.list", verb: "list", summary: "Список с фильтрами по dept/line/role/active." },
      { name: "managers.find_by_name", verb: "find", summary: "Поиск по имени (включая алиасы Maksim/Latin-C/Ukrainian-Є)." },
      { name: "managers.get_profile", verb: "get", summary: "Полная карта менеджера: профиль + текущее расписание." },
      { name: "managers.compare", verb: "compare", summary: "Параллельные метрики двух+ менеджеров за период." },
      { name: "managers.find_outliers", verb: "rank", summary: "Top-3 / bottom-3 / медиана по метрике за период." },
    ],
    key_tables: [
      "D1.master_managers",
      "D1.manager_schedule",
      "D1.payroll_runs",
      "D1.manager_bonuses",
    ],
    notes: [
      "ROP+line double-status (project_double_status memory): role='rop' AND line!=NULL → линейный сотрудник.",
      "B2G линии: 1=квалификатор, 2=бератер, 3=доведение. B2B: line всегда NULL.",
      "Soft-delete через is_active=false сохраняет FK в исторических звонках.",
    ],
  },
  okk: {
    domain: "okk",
    summary: "Реальные оценённые звонки. D2 для B2G, R2 для B2B. Filter: total_score IS NOT NULL AND manager_id IS NOT NULL (orphan-фильтр).",
    scope: "b2g+b2b",
    tools: [
      { name: "okk.summarise_quality", verb: "aggregate", summary: "Avg total_score, распределение, top/bottom 5 за период." },
      { name: "okk.get_call", verb: "get", summary: "Детали + evaluation_json одного звонка." },
      { name: "okk.find_calls", verb: "filter", summary: "Список звонков по dept/manager/score/dates/status. Limit 200." },
      { name: "okk.top_problems", verb: "aggregate", summary: "Кластеризация частых mistakes по периоду." },
      { name: "okk.audit_overrides", verb: "aggregate", summary: "Aggregations по override_metadata (Phase 2 audit signal)." },
      { name: "okk.coverage_heatmap", verb: "aggregate", summary: "Per-manager-per-day coverage_pct из phantom_history." },
    ],
    key_tables: [
      "D2/R2.calls",
      "D2/R2.evaluations",
      "D2/R2.managers",
      "D2/R2.phantom_history",
      "D2/R2.worst_calls",
    ],
    notes: [
      "evaluation_json структура: { blocks[], total_score, total_max_score, summary, client_scoring }; поддерживает legacy и новый форматы блоков.",
      "override_metadata кодирует follow-up детектирование, prior_count, call_type и применённые правила.",
      "voice_feedback (PII) намеренно исключён из MCP-tools — голосовые ответы менеджеров приватны.",
    ],
  },
  daily: {
    domain: "daily",
    summary: "План-факт + рефузалы. Phase 2b — упрощённая модель: list_metrics + plan_vs_fact для известных метрик + refusals топ.",
    scope: "b2g+b2b",
    tools: [
      { name: "daily.list_metrics", verb: "list", summary: "Какие metric_key есть в daily_plans для отдела." },
      { name: "daily.plan_vs_fact", verb: "compare", summary: "План vs факт для метрики (factor только для qual_leads, leads — Phase 3 расширит)." },
      { name: "daily.refusals", verb: "aggregate", summary: "Топ причин закрытия (B2G non_qual_enum_id, B2B b2b_close_reason_enum_id) с резолвом через refusal_enums." },
    ],
    key_tables: [
      "D1.daily_plans",
      "Analytics.leads_cohort",
      "Analytics.refusal_enums",
    ],
    notes: [
      "metric_key — string из dashboard configuration (см. metrics-config.ts). Phase 2b считает фактом только qual_leads / leads_count.",
      "B2G refusals = non_qual_enum_id (field 879824). B2B = b2b_close_reason_enum_id (field 876383, B2B pipelines 10631243/13209983).",
      "period_date формат: 'YYYY-MM-DD' (day) | 'YYYY-WNN' (ISO week) | 'YYYY-MM' (month).",
    ],
  },
  looker: {
    domain: "looker",
    summary: "Cohort + SLA анализ. Упрощённый — без integrator-snapshot fallback и alias-fold для имён.",
    scope: "b2g+b2b",
    tools: [
      { name: "looker.all_calls", verb: "aggregate", summary: "Per-manager call summary (total/out/in/messages/success_pct)." },
      { name: "looker.cohorts", verb: "aggregate", summary: "Per-manager lead_count + calls per lead + avg SLA первого звонка." },
      { name: "looker.sla_outliers", verb: "rank", summary: "Менеджеры с avg SLA ≥ threshold_minutes (минимум 5 leads)." },
    ],
    key_tables: [
      "Analytics.leads_cohort",
      "Analytics.communications",
      "Analytics.sla",
    ],
    notes: [
      "Per-dept pipeline whitelist: B2G={Бух Гос, Бух Бератер}, B2B={Бух Комм, Мед Комм}.",
      "SLA average — без integrator-snapshot fallback (Phase 4 будет COALESCE на sla_first_call_seconds_integrator).",
      "Имена менеджеров — как в analytics.communications.manager (без folding aliases). Для exact match с master_managers — Looker UI dashboard'а.",
    ],
  },
  tracking: {
    domain: "tracking",
    summary: "Раздел «Активность»: события Kommo (звонки, CRM-actions) per-manager. Источник tracking_events (отдельная Neon DB).",
    scope: "b2g+b2b",
    tools: [
      { name: "tracking.workload_summary", verb: "aggregate", summary: "Per-manager сводка: total_events, calls, total_call_min, distinct_event_types." },
      { name: "tracking.event_breakdown", verb: "aggregate", summary: "Распределение событий по event_type. Optional фильтр manager_id и types[]." },
      { name: "tracking.timeline", verb: "list", summary: "Per-day хронология одного менеджера. Limit 500 events." },
    ],
    key_tables: ["Tracking.tracking_events"],
    notes: [
      "manager_id — UUID master_managers.id как text (cross-DB FK).",
      "event_type примеры: outgoing_call, incoming_call, lead_added, lead_status_changed, custom_field_*_value_changed, task_*, note_*.",
      "duration_sec=0 для не-звонков. Berlin-civil-day boundaries.",
    ],
  },
  termin: {
    domain: "termin",
    summary: "B2G Бух Бератер pipeline (12154099) — cohort line chart срока от создания лида до termin DC/AA.",
    scope: "b2g-only",
    tools: [
      { name: "termin.cohort_chart", verb: "trend", summary: "Per-day avg_dc_days и avg_aa_days. AA baseline = MIN(event_at WHERE status_id=93886075) когда есть, иначе created_at." },
    ],
    key_tables: [
      "Analytics.leads_cohort (termin_date, aa_termin_date)",
      "Analytics.lead_status_changes (status_id=93886075 = TERM_DC_DONE)",
    ],
    notes: [
      "Только B2G (B2B не имеет termin pipeline). Pipeline_id = 12154099 (Бух Бератер).",
      "Excluded: NULL termin'ы, отрицательные intervals.",
      "termin_date / aa_termin_date — Kommo custom-fields, синкаются ETL'ом по name (см. project_session_20260428 memory).",
    ],
  },
  analytics: {
    domain: "analytics",
    summary: "Тренды и срезы AI-оценок (OKK реальные звонки + AI-ролевки) по периоду / менеджеру / критерию.",
    scope: "b2g+b2b",
    tools: [
      { name: "analytics.scores_by_period", verb: "trend", summary: "Avg total_score по day/week/month bucket'ам." },
      { name: "analytics.scores_by_manager", verb: "rank", summary: "Per-manager средний score за период (OKK или ролевки)." },
      { name: "analytics.criterion_drift", verb: "drilldown", summary: "Динамика одного criterion (по name) внутри evaluation_json. Только OKK." },
    ],
    key_tables: [
      "D2/R2.calls + evaluations (source=okk)",
      "D1.d1_calls / R1.r1_calls (source=roleplay)",
    ],
    notes: [
      "source='okk' — реальные оценённые звонки; source='roleplay' — AI-роли через d1_calls/r1_calls.",
      "Применяется orphan-фильтр (total_score IS NOT NULL).",
      "criterion_drift через jsonb_path_query_first — Postgres 12+. Возвращает avg per bucket.",
    ],
  },
};

export function registerDiscovery(server: McpServer): void {
  registerTool(server, {
    name: "list_domains",
    description:
      "Возвращает каталог доступных доменов tools. Первый вызов агента — даёт обзор того, что он может спросить.",
    inputShape: {},
    policy: {},
    handler: async () => ({
      domains: CATALOG.map((d) => ({ ...d })),
      total_tools: CATALOG.reduce((s, d) => s + d.tool_count, 0),
    }),
  });

  registerTool(server, {
    name: "describe_domain",
    description:
      "Детальное описание одного домена: tools, ключевые таблицы, известные правила. Используй когда видишь домен в list_domains и хочешь понять что в нём есть.",
    inputShape: {
      domain: z.string().describe("Имя домена (например 'managers' или 'okk')"),
    },
    policy: {},
    handler: async ({ domain }) => {
      const desc = DESCRIPTIONS[domain];
      if (!desc) {
        return {
          error: `Unknown domain: ${domain}. Available: ${Object.keys(DESCRIPTIONS).join(", ")}`,
        };
      }
      return desc;
    },
  });

  registerTool(server, {
    name: "glossary",
    description:
      "Бизнес-словарь проекта. Если term указан — возвращает определение; иначе — полный индекс. Используй при встрече незнакомого термина.",
    inputShape: {
      term: z.string().optional().describe("Опциональный термин"),
    },
    policy: {},
    handler: async ({ term }) => {
      if (term) {
        const def = GLOSSARY[term.toLowerCase()];
        return def
          ? { term, definition: def }
          : { error: `Unknown term: ${term}. См. полный индекс через glossary() без аргумента.` };
      }
      return { terms: GLOSSARY };
    },
  });
}

const GLOSSARY: Record<string, string> = {
  d1: "Neon DB B2G ролевки + master_managers + общие таблицы (Госники / Дима).",
  r1: "Neon DB B2B ролевки (Коммерсы / Рузанна). Та же физическая БД что D1, другая branch.",
  d2: "Neon DB B2G OKK — реальные оценённые звонки Госников.",
  r2: "Neon DB B2B OKK — реальные оценённые звонки Коммерсов.",
  analytics: "Neon DB зеркало 3rd-party Looker-интегратора. analytics.* схема. Главный источник для Daily/Звонки/Looker/Termin.",
  tracking: "Neon DB кеш Kommo событий. Отдельный проект. Питает Активность.",
  b2g: "Госники — отдел дмитрия. Department code 'b2g'. Pipelines в Kommo: разные для B2G не унифицированы; 12154099 = Бух Бератер.",
  b2b: "Коммерсы — отдел рузанны. Department code 'b2b'. Pipelines: 10631243=Бух Комм, 13209983=Мед Комм.",
  rop: "Руководитель отдела продаж. role='rop' в master_managers. Если дополнительно line!=NULL → double-status: одновременно работает на линии (например Татьяна Дерикова line=2).",
  line: "Только B2G. '1'=квалификатор, '2'=бератер, '3'=доведение. B2B всегда NULL.",
  okk: "Отдел качества. Раздел дашборда «ОКК» показывает реальные звонки с AI-оценкой.",
  evaluation: "AI-оценка одного звонка: total_score (0-100) + JSON-структура { blocks[], criteria[], summary, client_scoring }.",
  pattern_a: "Один CDR-звонок → N rows в analytics.communications, по одному на каждого matched лида (после enrich-telephony-leads). Composite UNIQUE(communication_id, COALESCE(lead_id,0)).",
  sla_first_call: "Business-hours время от создания лида до первого outbound-звонка ОТВЕТСТВЕННОГО менеджера. NULL когда: нет outbound звонка ИЛИ outbound только от не-responsible.",
  tlt: "Time between Latest Touches. BH-time между двумя последними outbound-звонками responsible-менеджера на одном лиде. NULL когда у менеджера 0–1 звонок.",
  term_dc_done: "Kommo status_id 93886075 в leads_cohort.status_id. Маркер выполнения «Дата термина ДЦ» в B2G Бух Бератер pipeline.",
  override_metadata: "JSON в okk.evaluations описывающий программные корректировки AI-оценки: is_followup, call_type, overrides_applied[], score_before/after_override.",
  name_drift: "Известная проблема: master_managers.name vs analytics.communications.manager имеют 3 расхождения (Maksim/Latin-C/Ukrainian-Є). Алиас-таблица в src/lib/daily/name-aliases.ts.",
  berlin: "Все date boundaries и civil-day считаются в Europe/Berlin, не UTC. Касается period filters, daily snapshots, schedule_date, payroll_runs.period_month.",
};
