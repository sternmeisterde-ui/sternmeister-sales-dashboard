import { NextRequest, NextResponse } from "next/server";
import { getOkkDbForDepartment } from "@/lib/db/okk";
import { getDbForDepartment, db } from "@/lib/db";
import {
  okkCalls,
  okkEvaluations,
  okkManagers,
} from "@/lib/db/schema-okk";
import { d1Users, d1Calls, r1Users, r1Calls, analyticsExcludedCalls } from "@/lib/db/schema-existing";
import { eq, sql, and, or, gte, lte, isNotNull, isNull, inArray, desc } from "drizzle-orm";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { cached } from "@/lib/kommo/cache";
import { getLines, KOMMO, type DepartmentId } from "@/lib/config/tenant";
import { parseDateBoundary, addDaysCivil, todayCivil, APP_TZ } from "@/lib/utils/date";

const CACHE_TTL = 2 * 60 * 1000;

// Synthetic key for calls whose managerId / userId is NULL — keeps per-manager
// sums equal to per-period sums (every counted call lives in exactly one
// bucket). Surfaced in the breakdown as "Без менеджера".
const NO_MANAGER_KEY = "__no_manager__";

const EXCLUDED_BLOCKS = new Set([
  "Рекомендации",
  "Фильтры",
  "Скоринг",
  "Скоринг клиента",
]);

// Диагностические/аналитические критерии (в основном type:"info_text",
// scoring:false) — не метрики качества, скрываем из дерева аналитики по
// просьбе владельца (2026-06-05). Имена в НОРМАЛИЗОВАННОЙ форме: проверка
// идёт после stripNumericPrefix + normalizeName(CRITERIA_NAME_MAP), поэтому
// "Экспертный стиль установновления раппорта" сравнивается уже как
// "...установления...". Применяется в loadCanonicalCriteria (убрать колонку)
// и processBlocks (не аккумулировать).
const EXCLUDED_CRITERIA = new Set([
  "Какие возражения озвучил Клиент (теги)",
  "Какие техники отработки возражений стоило бы применить Продавцу",
  "Оценка звонка по международным методологиям",
  "Структура звонка: фактический скрипт, который применил Продавец",
  "Что заставит этого Клиента купить (тип, реакция и болеутоляющая формула)",
  "Неиспользованные УТП, которые могли бы повлиять",
  "Экспертный стиль установления раппорта",
]);

// ИСТОРИЯ (2026-06-11): раньше OKK писал score=0 ВСЕМ нескоринговым
// критериям («Критические ошибки», «Talk ratio», «Потеря клиента»)
// независимо от вердикта LLM — парсинг нулей давал ложные 0%, поэтому
// критерий попадает в агрегат только при max_score > 0.
//
// КОНТРАКТ ВЫПОЛНЕН (с 2026-06-11 в OKK, проверено на проде 2026-07-02:
// 127/127 свежих r2-оценок): OKK пишет реальные вердикты с max_score=1
// (binary) и max_score=100 (Talk ratio) — стандартная ветка `cMax > 0` их
// подхватывает, а старые «нулевые» оценки (max_score=0) отсеиваются сами и
// рендерятся «—». Особая раскраска на клиенте — ALWAYS_INVERTED_CRITERIA /
// SPELLIT_INVERTED_CRITERIA / NEUTRAL_CRITERIA в AnalyticsTab.tsx.

// ─── Types ──────────────────────────────────────────────────

interface CriterionScore {
  name: string;
  scores: Record<string, number>;
}

interface BlockData {
  name: string;
  scores: Record<string, number>;
  criteria: CriterionScore[];
}

interface ManagerCriterionScore {
  name: string;
  score: number | null; // null = no data for this criterion
}

interface ManagerBlockScore {
  name: string;
  score: number | null; // null = no data
  criteria: ManagerCriterionScore[];
}

interface ManagerBreakdown {
  id: string;
  name: string;
  overallScore: number | null;
  callCount: number;
  blocks: ManagerBlockScore[];
}

// B2B-only: дерево «неделя → менеджер → дата». Колонки — ОЦЕНКА + блоки/
// критерии. `overall` = средний % за звонок; `scores` — баллы по колонкам
// (ключ = имя блока ИЛИ "блок::критерий"), call-weighted средние. Уровни
// агрегируются из сырых сумм/счётчиков (см. aggAccs), поэтому веса звонков
// сохраняются на каждом уровне. Референс — выгрузка ОКК в Google Sheets.
interface TimeTreeNode {
  callCount: number;
  overall: number | null;
  scores: Record<string, number>;
}
// 4-й уровень — отдельный звонок/сделка. У OKK несёт kommo-ссылку; у roleplay
// kommoLead* = null (нет сделки), только аудио + транскрипт. overall =
// total_score звонка; scores — его собственные баллы по колонкам.
interface TimeTreeCall extends TimeTreeNode {
  callId: string;
  startedAt: string | null;       // ISO; время начала звонка (call_created_at)
  durationSec: number | null;
  direction: string | null;       // 'inbound' | 'outbound'
  kommoLeadId: string | null;
  kommoLeadUrl: string | null;    // прямая ссылка на сделку в Kommo
}
interface TimeTreeDate extends TimeTreeNode { date: string; calls: TimeTreeCall[] }
interface TimeTreeManager extends TimeTreeNode { id: string; name: string; dates: TimeTreeDate[] }
interface TimeTreeWeek extends TimeTreeNode { key: string; label: string; managers: TimeTreeManager[] }

interface AnalyticsResponse {
  periods: string[];
  blocks: BlockData[];
  overallScores: Record<string, number>;
  managers: Array<{ id: string; name: string }>;
  managerBreakdown: ManagerBreakdown[];
  // Пусто для всех, кроме B2B. Считается только когда department === "b2b".
  timeTree: TimeTreeWeek[];
  totalCalls: number;
  source: string;
  department: string;
}

// ─── Period helpers (Berlin civil-day bucketing) ─────────────
//
// Every bucket key is derived from the Berlin civil date of the call —
// never the UTC date. A 23:30 Berlin call and a 00:30 Berlin call on the
// next day are different days for the user even though they're an hour
// apart in UTC. Mixing UTC bucketing with the SQL `BETWEEN` filter (which
// is also Berlin-aware below) used to leak calls across day boundaries.

function toBerlinCivil(date: Date): string {
  return date.toLocaleDateString("en-CA", { timeZone: APP_TZ });
}

function isoWeekOfCivil(civilStr: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(civilStr);
  if (!match) return civilStr;
  const [, y, m, d] = match;
  // Pure calendar pivot — Date.UTC isn't being used as an instant here.
  const dt = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  const dayNum = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil(((dt.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${dt.getUTCFullYear()}-W${String(weekNum).padStart(2, "0")}`;
}

// Monday-based week containing the given civil date. Returns a sortable key
// (Monday's YYYY-MM-DD) and a "start - end" label (Mon–Sun) matching the
// reference sheet's «2026-05-11 - 2026-05-17» week rows. Pure calendar math —
// Date.UTC isn't used as an instant.
function weekRange(civil: string): { key: string; label: string } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(civil);
  if (!m) return { key: civil, label: civil };
  const [, y, mo, d] = m;
  const dt = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  const dow = dt.getUTCDay() || 7; // 1..7 (Mon..Sun)
  const monday = new Date(dt);
  monday.setUTCDate(dt.getUTCDate() - (dow - 1));
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  const iso = (x: Date) => x.toISOString().slice(0, 10);
  return { key: iso(monday), label: `${iso(monday)} - ${iso(sunday)}` };
}

function toPeriodKey(date: Date, groupBy: string): string {
  const civil = toBerlinCivil(date);
  switch (groupBy) {
    case "day": return civil;
    case "week": return isoWeekOfCivil(civil);
    case "month": return civil.slice(0, 7);
    default: return civil;
  }
}

function buildPeriodRange(fromCivil: string, toCivil: string, groupBy: string): string[] {
  const periods = new Set<string>();
  let cur = fromCivil;
  while (cur <= toCivil) {
    if (groupBy === "day") periods.add(cur);
    else if (groupBy === "month") periods.add(cur.slice(0, 7));
    else periods.add(isoWeekOfCivil(cur));
    cur = addDaysCivil(cur, 1);
  }
  return [...periods].sort();
}

// ─── Prompt-type filter mapping ──────────────────────────────
//
// Each UI line pill = one prompt_type (so the criteria table always matches
// the prompt's JSON schema in src/criteria/*.json). For B2G that means 4
// pills × 4 prompts: d2_qualifier / d2_berater / d2_berater2 / d2_dovedenie.
// "Линия 2" conceptually covers both Бератер 1 and Бератер 2 — they're
// shown as separate pills in the UI, never as a merged "Бератер" group.
//
// NOTE: a previous iteration tried filtering by managers.line instead, to
// pull all Кристина+Лихварь (line=3) calls into the Доведение tab even
// when OKK had evaluated them with the d2_berater prompt (because OKK
// routes by Kommo stage, not by role). That broke criteria rendering —
// evaluation_json from d2_berater has different block names than the
// d2_dovedenie.json criteria schema, so all rows except "Приветствие"
// showed dashes. Fix belongs in OKK (re-eval those calls under
// d2_dovedenie), not here.

function getOkkPromptTypes(department: string, line: string): string[] | null {
  if (department !== "b2g" && department !== "b2b") return null;
  if (line === "all" || !line) return null;
  const lines = getLines(department as DepartmentId);
  const exact = lines.find((l) => l.id === line);
  if (exact) return [exact.promptType];
  const inGroup = lines.filter((l) => l.group === line).map((l) => l.promptType);
  return inGroup.length > 0 ? inGroup : null;
}

// ─── Funnel labels for "Все" mode ──────────────────────────
//
// When line=all the left column lists funnels (one row per active line)
// instead of criteria — B2G funnels (Квалификатор/Бератер/Доведение) have
// disjoint criteria sets so cross-funnel criteria-level rows are noise.
// Funnel label = whatever shortLabel the prompt_type maps to in tenant.ts.

function funnelLabelForOkk(department: DepartmentId, promptType: string | null): string {
  if (!promptType) return "Без воронки";
  const line = getLines(department).find((l) => l.promptType === promptType);
  return line ? (line.shortLabel ?? line.label) : promptType;
}

function funnelLabelForRoleplay(department: DepartmentId, callType: string | null): string {
  if (department === "b2b") return "Все звонки"; // single roleplay script
  if (!callType) return "Без воронки";
  switch (callType) {
    case "qualifier": return "Квалификатор";
    case "berater": return "Бератер";
    case "dovedenie": return "Доведение";
    default: return callType;
  }
}

function funnelOrderForOkk(department: DepartmentId): string[] {
  return getLines(department).map((l) => l.shortLabel ?? l.label);
}

function funnelOrderForRoleplay(department: DepartmentId): string[] {
  if (department === "b2b") return ["Все звонки"];
  return ["Квалификатор", "Бератер", "Доведение"];
}

// Treat a single call as one entry under its funnel label. Uses total_score
// directly (already 0–100) so the funnel's averaged score stays comparable
// to the "Средний балл" overall row.
function processCallAsFunnel(
  acc: PeriodAcc,
  totalScore: number | null,
  funnelLabel: string,
): boolean {
  if (totalScore === null || totalScore === undefined) return false;
  const fe = acc.blocks.get(funnelLabel);
  if (fe) {
    fe.scoreSum += totalScore;
    fe.count++;
  } else {
    acc.blocks.set(funnelLabel, { scoreSum: totalScore, count: 1 });
  }
  acc.callCount++;
  acc.totalScoreSum += totalScore;
  acc.totalScoreCount++;
  return true;
}

// ─── Name normalization (old evaluation versions used different names) ──

const BLOCK_NAME_MAP: Record<string, string> = {
  "Предзакрытие и FOMO": "Предзакрытие и ФОМО",
};

const CRITERIA_NAME_MAP: Record<string, string> = {
  "Экспертный стиль установновления раппорта": "Экспертный стиль установления раппорта",
  'Продавец корректно отработал ложные возражения ("подумаю", "посоветуюсь", "не сейчас")': "Продавец корректно отработал ложные возражения",
  // Мед-конфиг использует «фигурные» кавычки — сводим к тому же канону, что и Бух.
  "Продавец корректно отработал ложные возражения (“подумаю”, “посоветуюсь”, “не сейчас”)": "Продавец корректно отработал ложные возражения",
};

// ── Раскладка Spellit («Дашборд 1 — Применимость критериев») ─────────
// Владелец сверяет вкладку «Оценка критериев» с отчётом Spellit: те же
// критерии, та же группировка. Группировка Spellit НЕ совпадает со `stages`
// конфига (напр., «Small talk» → Установление контакта, «Преимущества
// профессии» → Презентация, «Реферальная» + сторителлинг/слушание/
// самоконтроль → Экспертный блок, «Критические ошибки» + Talk ratio →
// Стандарты общения). Раскладка сверена с pivot-определением самого
// «Дашборда 1» (OKK dev_docs/spellit-dashboard1-analysis, 2026-07-02).
// Поэтому для Коммерсов (r2_commercial / r2_med_commercial) блоки берём
// ОТСЮДА, а не из stages конфига. Строки — нормализованные имена критериев
// (после stripNumericPrefix + CRITERIA_NAME_MAP); матчинг через looseKey
// (кавычки/регистр/пробелы).
const SPELLIT_PROMPT_TYPES = new Set(["r2_commercial", "r2_med_commercial"]);

// Скоринг клиента: сырые баллы (0–10, итог 0–30), НЕ проценты. Живут не в
// blocks оценки, а в evaluation_json.client_scoring (см.
// accumulateClientScoring). Порядок колонок — как у Spellit.
const CLIENT_SCORING_BLOCK = "Скоринг клиента";
const CLIENT_SCORING_CRITERIA = [
  "Итоговый скоринг",
  "Потребность",
  "Платежеспособность",
  "Срочность",
] as const;

const SPELLIT_GROUPING: ReadonlyArray<{ block: string; criteria: readonly string[] }> = [
  { block: "Установление контакта", criteria: [
    "Приветствие и установление контакта",
    "Озвучен план разговора (программирование)",
    "Корректная отработка вопроса о стоимости (если он прозвучал)",
    "Корректная отработка вопроса о JobCenter (если он прозвучал)",
    "Small talk и установление контакта",
  ] },
  { block: "Выявление потребностей", criteria: [
    "Точка А (выявить и усилить боль)",
    "Ситуативные вопросы в Точке А",
    "Точка В (ожидания, готовность, срочность)",
    "Уточнение SMART-целей Клиента",
    "Резюмирование целей и сроков перед презентацией",
  ] },
  { block: "Презентация продукта", criteria: [
    "Презентация проведена с опорой на цели и запрос Клиента",
    "Презентация проведена в формате диалога, с вовлечением Клиента",
    "Преимущества профессии Бухгалтера",
    "Преимущества профессии Медицинский администратор",
  ] },
  { block: "Предзакрытие и ФОМО", criteria: [
    "Что откликнулось Клиенту в презентации и готовность клиента начать",
    "Предзакрытие, FOMO и тактика дефицита",
  ] },
  { block: "Отработка возражений", criteria: [
    "Отработка возражений по структуре",
    "Продавец корректно отработал ложные возражения",
  ] },
  { block: "Этап оплаты", criteria: [
    "Продавец порекомендовал вариант оплаты и дал аргументацию",
    "Продавец узнал, подходит ли предложенный вариант оплаты Клиенту",
    "Продавец предложил приступить к обучению",
    "Следующие шаги",
  ] },
  { block: "Экспертный блок", criteria: [
    "Реферальная программа",
    "Применение сторителлинга",
    "Продавец использовал активное слушание и отзеркаливание Клиента",
    "Продавец был корректен и сохранял самоконтроль",
  ] },
  { block: "Стандарты общения", criteria: [
    "Общая доброжелательность и вежливость Продавца",
    "Критические ошибки с точки зрения компании",
    "Критические ошибки с точки зрения клиента",
    "Критические ошибки с точки зрения закона",
    "Talk ratio Продавца",
  ] },
  { block: CLIENT_SCORING_BLOCK, criteria: CLIENT_SCORING_CRITERIA },
];

// Матчинг имён: «фигурные» кавычки → прямые, схлопнуть пробелы, lower-case.
function looseKey(s: string): string {
  return s.replace(/[“”„«»]/g, '"').replace(/\s+/g, " ").trim().toLowerCase();
}

const SPELLIT_BLOCK_ORDER: string[] = SPELLIT_GROUPING.map((g) => g.block);

// looseKey(критерий) → { block, order }. Критерии вне карты в Spellit-виде НЕ
// показываются (инфо-теги, рекомендации, нарратив, «Потеря клиента» и т.п.).
const SPELLIT_BLOCK_OF: Map<string, { block: string; order: number }> = (() => {
  const m = new Map<string, { block: string; order: number }>();
  SPELLIT_GROUPING.forEach(({ block, criteria }, bi) =>
    criteria.forEach((c, ci) => m.set(looseKey(c), { block, order: bi * 100 + ci })),
  );
  return m;
})();

function normalizeName(name: string, map: Record<string, string>): string {
  return map[name] ?? name;
}

// Strip a leading "N. " (or "01. ", "23. ") numeric prefix that some prompt
// versions add for the LLM. The canonical name in src/criteria/*.json is
// always the bare form, so stripping here lets the same criterion match
// across rows that were evaluated under different prompt versions.
function stripNumericPrefix(name: string): string {
  return name.replace(/^\s*\d+\.\s*/, "").trim();
}

// ─── Canonical block / criteria order from JSON config ─────────
//
// The Criteria tab (src/criteria/*.json) is the single source of truth for
// which blocks/criteria exist. Reading it here means: the moment an admin
// edits criteria via /api/criteria, Analytics picks up the new structure
// (subject only to the 2-min cache TTL). It also kills the duplicate-row
// problem caused by mixing data from multiple prompt_types — every criterion
// is keyed by its canonical (prefix-stripped, alias-resolved) name, and
// criteria not in JSON are dropped instead of being shown half-empty.

interface CanonicalCriteria {
  blockOrder: string[];
  blockCriteria: Map<string, string[]>;
  // Set of canonical "block::criterion" keys for fast membership check.
  validKeys: Set<string>;
}

const EMPTY_CANONICAL: CanonicalCriteria = {
  blockOrder: [],
  blockCriteria: new Map(),
  validKeys: new Set(),
};

async function loadCanonicalCriteria(
  promptTypes: string[],
  useSpellit = false,
  // Колонки «Скоринга клиента» показываем только там, где их реально
  // накапливаем (OKK-звонки Коммерсов); у ролевок их нет.
  includeClientScoring = false,
): Promise<CanonicalCriteria> {
  const blockOrder: string[] = [];
  const blockCriteria = new Map<string, string[]>();
  const blockCriteriaSets = new Map<string, Set<string>>();
  const validKeys = new Set<string>();

  for (const pt of promptTypes) {
    const filePath = path.join(process.cwd(), "src", "criteria", `${pt}.json`);
    try {
      const content = await readFile(filePath, "utf-8");
      const json = JSON.parse(content) as { stages?: Array<{ name?: string; criteria?: Array<{ name?: string }> }> };
      const stages = Array.isArray(json.stages) ? json.stages : [];
      for (const stage of stages) {
        const rawBlockName = typeof stage.name === "string" ? stage.name : "";
        if (!rawBlockName || EXCLUDED_BLOCKS.has(rawBlockName)) continue;
        const blockName = normalizeName(rawBlockName, BLOCK_NAME_MAP);
        if (!blockCriteriaSets.has(blockName)) {
          blockCriteriaSets.set(blockName, new Set());
          blockCriteria.set(blockName, []);
          blockOrder.push(blockName);
        }
        const seen = blockCriteriaSets.get(blockName)!;
        const ordered = blockCriteria.get(blockName)!;
        const crits = Array.isArray(stage.criteria) ? stage.criteria : [];
        for (const c of crits) {
          const rawCName = typeof c.name === "string" ? c.name : "";
          if (!rawCName) continue;
          const cName = normalizeName(stripNumericPrefix(rawCName), CRITERIA_NAME_MAP);
          if (EXCLUDED_CRITERIA.has(cName)) continue;
          if (!seen.has(cName)) {
            seen.add(cName);
            ordered.push(cName);
            validKeys.add(`${blockName}::${cName}`);
          }
        }
      }
    } catch (e) {
      console.warn(`[Analytics] Failed to load criteria/${pt}.json:`, e instanceof Error ? e.message : e);
    }
  }

  if (!useSpellit) return { blockOrder, blockCriteria, validKeys };

  // Spellit-раскладка: берём КРИТЕРИИ, реально присутствующие в конфигах
  // (уже нормализованные выше), и раскладываем их по блокам Spellit в порядке
  // SPELLIT_GROUPING. Имена критериев берём фактические — чтобы совпадали с
  // ключами, которые построит regroupAccToSpellit.
  const present = new Set<string>();
  for (const arr of blockCriteria.values()) for (const c of arr) present.add(c);
  // Скоринг клиента лежит в конфиге под EXCLUDED_BLOCKS (его строки-критерии
  // в оценках пустые, 0/0) — данные приходят из evaluation_json.client_scoring,
  // поэтому включаем колонки принудительно.
  if (includeClientScoring) for (const c of CLIENT_SCORING_CRITERIA) present.add(c);

  const perBlock = new Map<string, Array<{ name: string; order: number }>>();
  for (const cName of present) {
    const sb = SPELLIT_BLOCK_OF.get(looseKey(cName));
    if (!sb) continue; // критерий не входит в Spellit-вид → не показываем
    if (!perBlock.has(sb.block)) perBlock.set(sb.block, []);
    perBlock.get(sb.block)!.push({ name: cName, order: sb.order });
  }

  const sBlockOrder: string[] = [];
  const sBlockCriteria = new Map<string, string[]>();
  const sValidKeys = new Set<string>();
  for (const block of SPELLIT_BLOCK_ORDER) {
    const arr = perBlock.get(block);
    if (!arr || arr.length === 0) continue;
    arr.sort((a, b) => a.order - b.order);
    const names = arr.map((x) => x.name);
    sBlockOrder.push(block);
    sBlockCriteria.set(block, names);
    for (const n of names) sValidKeys.add(`${block}::${n}`);
  }
  return { blockOrder: sBlockOrder, blockCriteria: sBlockCriteria, validKeys: sValidKeys };
}

// ─── Accumulator ────────────────────────────────────────────

interface PeriodAcc {
  totalScoreSum: number;
  totalScoreCount: number;
  blocks: Map<string, { scoreSum: number; count: number }>;
  criteria: Map<string, { scoreSum: number; count: number }>;
  callCount: number;
}

function newAcc(): PeriodAcc {
  return {
    totalScoreSum: 0,
    totalScoreCount: 0,
    blocks: new Map(),
    criteria: new Map(),
    callCount: 0,
  };
}

function processBlocks(
  blocks: unknown[],
  acc: PeriodAcc,
  totalScore: number | null,
): boolean {
  if (!blocks || blocks.length === 0) return false;

  let hadData = false;

  for (const rawBlock of blocks) {
    // Safely extract fields — handles both OKK EvalBlock and roleplay inline types
    const block = rawBlock as Record<string, unknown>;
    const rawName = typeof block.name === "string" ? block.name : "";
    if (!rawName || EXCLUDED_BLOCKS.has(rawName)) continue;
    const name = normalizeName(rawName, BLOCK_NAME_MAP);

    const blockScore = typeof block.block_score === "number" ? block.block_score
      : typeof block.score === "number" ? block.score : 0;
    const maxBlockScore = typeof block.max_block_score === "number" ? block.max_block_score
      : typeof block.max_score === "number" ? block.max_score : 0;

    // Блоки целиком из scoring:false критериев («Критические ошибки»,
    // «Экспертный блок») имеют max_block_score=0 — у них нет блочного балла,
    // но их критерии всё равно обрабатываем ниже (раньше continue выкидывал
    // блок целиком и в дереве стояло «—»).
    const hasBlockScore = maxBlockScore > 0;
    if (hasBlockScore) {
      hadData = true;
      const blockPct = Math.round((blockScore / maxBlockScore) * 100);
      const be = acc.blocks.get(name);
      if (be) { be.scoreSum += blockPct; be.count++; }
      else acc.blocks.set(name, { scoreSum: blockPct, count: 1 });
    }

    // Criteria — strip numeric prefix and resolve aliases so different
    // prompt versions ("1. Foo" vs "Foo") collapse into the same row.
    const criteria = Array.isArray(block.criteria) ? block.criteria : [];
    for (const rawC of criteria) {
      const c = rawC as Record<string, unknown>;
      const rawCName = typeof c.name === "string" ? c.name : "";
      if (!rawCName) continue;
      const cName = normalizeName(stripNumericPrefix(rawCName), CRITERIA_NAME_MAP);
      if (EXCLUDED_CRITERIA.has(cName)) continue;

      const cMax = typeof c.max_score === "number" ? c.max_score : 0;

      // Только критерии с настоящим скорингом (max_score > 0). Нескоринговые
      // сейчас несут score=0 без смысла (см. комментарий к ИСТОРИИ выше) —
      // показываем «—», пока OKK не начнёт писать реальные значения.
      if (cMax <= 0) continue;
      // Новый формат OKK (с 2026-06-11): у нескоринговых критериев
      // max_score > 0 и реальный вердикт, а «Пусто» (ситуация не возникла,
      // оценить нельзя) приходит как score: null — пропускаем, иначе null
      // коэрсится в 0 и даёт ложный 0%.
      if (typeof c.score !== "number") continue;
      const pct = Math.round((c.score / cMax) * 100);

      const key = `${name}::${cName}`;
      const ce = acc.criteria.get(key);
      if (ce) { ce.scoreSum += pct; ce.count++; }
      else acc.criteria.set(key, { scoreSum: pct, count: 1 });
    }
  }

  // Only count call if we actually extracted block data
  if (hadData) {
    acc.callCount++;
    if (totalScore !== null && totalScore !== undefined) {
      acc.totalScoreSum += totalScore;
      acc.totalScoreCount++;
    }
  }

  return hadData;
}

// Полярность Spellit для «Критических ошибок»: OKK пишет 1 = ошибок НЕ было,
// а в таблице Spellit колонка означает «доля звонков С ошибками» (выше =
// хуже, у идеального менеджера 0%). Инвертируем при материализации
// Spellit-вида — B2G-таблицы это не задевает. Клиентская раскраска этих
// колонок — SPELLIT_INVERTED_CRITERIA в AnalyticsTab.tsx (по флагу
// spellitView, т.к. вне Spellit-вида значения остаются прямыми).
const SPELLIT_INVERTED = new Set([
  "Критические ошибки с точки зрения компании",
  "Критические ошибки с точки зрения клиента",
  "Критические ошибки с точки зрения закона",
].map(looseKey));

// Критерии, которые НЕ входят в блочный средний процент (свёрнутая колонка
// блока): инвертированные (доля ошибок, выше=хуже) и нейтральный Talk ratio
// смешали бы в одном среднем «% хорошего», «% плохого» и сырой процент
// говорения — свёрнутые «Стандарты общения» выглядели бы красными при
// идеальных показателях. Скоринг клиента исключается отдельно (сырые баллы).
const SPELLIT_BLOCK_SUM_EXCLUDED = new Set([
  "Talk ratio Продавца",
].map(looseKey));

// ─── Перегруппировка под Spellit ────────────────────────────
// Перекладывает аккумулятор с ключей «configBlock::крит» на «spellitBlock::
// крит» и пересобирает блочные агрегаты (сумма по критериям блока). Критерии
// вне карты Spellit отбрасываются. totalScore/overall не трогаем — они не
// зависят от группировки. Применяется после набора всех аккумуляторов и до
// buildResponse, только для Коммерсов (см. SPELLIT_PROMPT_TYPES).
function regroupAccToSpellit(acc: PeriodAcc): void {
  const nc = new Map<string, { scoreSum: number; count: number }>();
  const nb = new Map<string, { scoreSum: number; count: number }>();
  for (const [key, ce] of acc.criteria) {
    const sepIdx = key.indexOf("::");
    const cName = sepIdx >= 0 ? key.slice(sepIdx + 2) : key;
    const lk = looseKey(cName);
    const sb = SPELLIT_BLOCK_OF.get(lk);
    if (!sb) continue;
    // Инверсия полярности: avg → 100−avg через сырые суммы (sum/count).
    const entry = SPELLIT_INVERTED.has(lk)
      ? { scoreSum: 100 * ce.count - ce.scoreSum, count: ce.count }
      : ce;
    // Один и тот же критерий может прийти из разных config-блоков (разные
    // prompt-версии) — сливаем, а не перезаписываем.
    const nk = `${sb.block}::${cName}`;
    const prev = nc.get(nk);
    if (prev) { prev.scoreSum += entry.scoreSum; prev.count += entry.count; }
    else nc.set(nk, entry);
    // В блочный средний идут только «обычные» процентные критерии: сырые
    // баллы скоринга, доля ошибок и talk ratio исказили бы свёрнутый блок.
    if (sb.block === CLIENT_SCORING_BLOCK || SPELLIT_INVERTED.has(lk) || SPELLIT_BLOCK_SUM_EXCLUDED.has(lk)) continue;
    const be = nb.get(sb.block);
    if (be) { be.scoreSum += entry.scoreSum; be.count += entry.count; }
    else nb.set(sb.block, { scoreSum: entry.scoreSum, count: entry.count });
  }
  acc.criteria = nc;
  acc.blocks = nb;
}

function regroupAllToSpellit(...maps: Array<Map<string, PeriodAcc>>): void {
  for (const m of maps) for (const acc of m.values()) regroupAccToSpellit(acc);
}

// Скоринг клиента из evaluation_json.client_scoring → аккумулятор (сырые
// баллы 0–10, итог 0–30; average по звонкам). «Итоговый скоринг» считаем
// суммой компонентов сами: OKK хранит его обрезанным до 10 (LLM-схема
// критерия 51 — scale_0_10), а Spellit ждёт 0–30; «Пусто» в компоненте
// суммируется как 0 — ровно по промту критерия 51. Ключи кладём сразу в
// Spellit-блок, чтобы regroupAccToSpellit их сохранил (звонки без
// client_scoring просто не входят в среднее).
function accumulateClientScoring(evalJson: Record<string, unknown> | null, acc: PeriodAcc): void {
  const cs = evalJson?.client_scoring as Record<string, unknown> | undefined;
  if (!cs || typeof cs !== "object") return;
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  const urgency = num(cs.urgency);
  const solvency = num(cs.solvency);
  const need = num(cs.need);
  const total = urgency === null && solvency === null && need === null
    ? null
    : (urgency ?? 0) + (solvency ?? 0) + (need ?? 0);
  const vals: Array<[string, number | null]> = [
    ["Итоговый скоринг", total],
    ["Потребность", need],
    ["Платежеспособность", solvency],
    ["Срочность", urgency],
  ];
  for (const [name, v] of vals) {
    if (v === null) continue;
    const key = `${CLIENT_SCORING_BLOCK}::${name}`;
    const ce = acc.criteria.get(key);
    if (ce) { ce.scoreSum += v; ce.count++; }
    else acc.criteria.set(key, { scoreSum: v, count: 1 });
  }
}

// ─── OKK data fetcher ───────────────────────────────────────

async function fetchOkkData(
  department: "b2g" | "b2b",
  line: string,
  from: Date,
  to: Date,
  fromCivil: string,
  toCivil: string,
  groupBy: string,
  managerIds: string[],
  wantTree: boolean,
  excludedCallIds: Set<string>,
  minDurSec: number,
): Promise<AnalyticsResponse> {
  const db = getOkkDbForDepartment(department);
  const promptTypes = getOkkPromptTypes(department, line);
  // Коммерсы (r2_commercial / r2_med_commercial) → таблицы критериев в
  // раскладке Spellit (перегруппировка блоков). Применяется только в режиме
  // конкретной линии (не «все воронки»), т.е. внутри ветки !isAllFunnels.
  const useSpellit = !!promptTypes && promptTypes.some((pt) => SPELLIT_PROMPT_TYPES.has(pt));

  // Уволенных менеджеров не показываем нигде в ОКК. Флаг okkManagers.isActive
  // синкается из master_managers (источник правды): при увольнении sync ставит
  // is_active=false в R2/D2.managers. Поэтому фильтруем по okk-стороне (тот же
  // R2/D2-коннекшн — id okk-менеджеров НЕ равны master.id, связь по
  // kommoUserId/telegramId/name, см. /api/managers). Звонки уволенных выпадают
  // из выборки целиком, чтобы итоги периода сходились с разбивкой по менеджерам
  // (как в Дейли/Активности). Звонки без менеджера (NULL) — оставляем.
  const activeOkk = await db
    .select({ id: okkManagers.id })
    .from(okkManagers)
    .where(eq(okkManagers.isActive, true));
  const activeOkkIds = activeOkk.map((m) => m.id);

  const conditions = [
    sql`${okkCalls.callCreatedAt} >= ${from}`,
    sql`${okkCalls.callCreatedAt} <= ${to}`,
    sql`${okkCalls.status} IN ('notified', 'evaluated', 'completed')`,
    isNotNull(okkEvaluations.totalScore),
    or(
      inArray(okkEvaluations.managerId, activeOkkIds),
      isNull(okkEvaluations.managerId),
    ),
  ];
  if (promptTypes && promptTypes.length > 0) {
    conditions.push(inArray(okkEvaluations.promptType, promptTypes));
  }
  if (managerIds.length) {
    conditions.push(inArray(okkEvaluations.managerId, managerIds));
  }
  // Тумблер «как в Spellit»: их Дашборд 1 пускает только звонки от 15 минут,
  // OKK оценивает от 10 — для сверки цифр бок о бок нужна одинаковая выборка.
  if (minDurSec > 0) {
    conditions.push(sql`${okkCalls.durationSeconds} >= ${minDurSec}`);
  }

  // Manager dropdown lists every currently-active manager/ROP in the
  // department. We deliberately do NOT scope it to the selected line so a
  // user switching from "Линия 1" to "Бератер 1" doesn't lose access to the
  // full roster. Per-line scoping happens on the call rows themselves via
  // `prompt_type`. New hires/fires flow in automatically through the
  // `master_managers` sync (is_active toggle).
  const managerConditions = [
    eq(okkManagers.isActive, true),
    sql`${okkManagers.role} IN ('manager', 'teamlead', 'rop')`,
  ];

  const [rawRows, managers] = await Promise.all([
    db
      .select({
        callId: okkCalls.id,
        callCreatedAt: okkCalls.callCreatedAt,
        durationSeconds: okkCalls.durationSeconds,
        direction: okkCalls.direction,
        kommoLeadId: okkCalls.kommoLeadId,
        kommoLeadUrl: okkCalls.kommoLeadUrl,
        totalScore: okkEvaluations.totalScore,
        evaluationJson: okkEvaluations.evaluationJson,
        managerId: okkEvaluations.managerId,
        promptType: okkEvaluations.promptType,
      })
      .from(okkCalls)
      .innerJoin(okkEvaluations, eq(okkCalls.id, okkEvaluations.callId))
      .where(and(...conditions))
      // Latest evaluation first so the dedupe below keeps the active one.
      // Re-evaluations (different prompt version, retries) create extra rows
      // in `evaluations`; without this dedupe, a call with N evaluations was
      // counted N times in callCount/breakdown.
      .orderBy(desc(okkEvaluations.createdAt)),
    db
      .select({ id: okkManagers.id, name: okkManagers.name })
      .from(okkManagers)
      .where(and(...managerConditions)),
  ]);

  const seenCallIds = new Set<string>();
  const rows = rawRows.filter((r) => {
    // Moderator-excluded calls are dropped entirely — out of the tree AND
    // every aggregate (manager/day/week/period/criteria).
    if (excludedCallIds.has(r.callId)) return false;
    if (seenCallIds.has(r.callId)) return false;
    seenCallIds.add(r.callId);
    return true;
  });

  const periods = buildPeriodRange(fromCivil, toCivil, groupBy);
  const accMap = new Map<string, PeriodAcc>();
  for (const p of periods) accMap.set(p, newAcc());

  // Per-manager accumulators (aggregate across all periods). Calls without
  // a managerId go into a synthetic bucket so per-period and per-manager
  // sums stay consistent — every counted call lives in exactly one bucket.
  const managerAccMap = new Map<string, PeriodAcc>();

  // Two aggregation modes:
  //   funnels — line=all, accumulate per funnel label (one row per active
  //     line in the dept). Block names = funnel labels, criteria = [].
  //   criteria — line=specific, accumulate per block/criterion as before
  //     and key off the canonical JSON config.
  const isAllFunnels = line === "all" || !line;

  // B2B: аккумулятор «менеджер × день» для дерева неделя→менеджер→дата.
  // Ключ — civil-день (не period), чтобы дерево не зависело от groupBy: неделя
  // выводится из дня в buildResponse (weekRange).
  const managerDayAccMap = new Map<string, PeriodAcc>();
  // 4-й уровень дерева: список звонков на бакет «менеджер::день».
  const managerDayCallsMap = new Map<string, TimeTreeCall[]>();
  const wantManagerTime = department === "b2b" && wantTree;

  let processedCount = 0;
  for (const row of rows) {
    if (!row.callCreatedAt) continue;
    const evalJson = row.evaluationJson as Record<string, unknown> | null;
    const blocks = evalJson && Array.isArray(evalJson.blocks) ? evalJson.blocks : null;
    if (!blocks || blocks.length === 0) continue;

    const p = toPeriodKey(row.callCreatedAt, groupBy);
    const acc = accMap.get(p);
    if (!acc) continue;

    // Reconciliation guarantee: a call is counted by the per-manager bucket
    // ONLY if the per-period bucket also accepted it. Otherwise a row whose
    // blocks all have max_score=0 (processBlocks → had=false) would be
    // skipped period-side but still bump the manager total — totals diverge.
    let had: boolean;
    if (isAllFunnels) {
      const funnel = funnelLabelForOkk(department, row.promptType);
      had = processCallAsFunnel(acc, row.totalScore, funnel);
    } else {
      had = processBlocks(blocks, acc, row.totalScore);
      if (had && useSpellit) accumulateClientScoring(evalJson, acc);
    }
    if (!had) continue;
    processedCount++;

    const mgrKey = row.managerId ?? NO_MANAGER_KEY;
    if (!managerAccMap.has(mgrKey)) managerAccMap.set(mgrKey, newAcc());
    if (isAllFunnels) {
      const funnel = funnelLabelForOkk(department, row.promptType);
      processCallAsFunnel(managerAccMap.get(mgrKey)!, row.totalScore, funnel);
    } else {
      processBlocks(blocks, managerAccMap.get(mgrKey)!, row.totalScore);
      if (useSpellit) accumulateClientScoring(evalJson, managerAccMap.get(mgrKey)!);
    }

    // Тот же звонок → бакет «менеджер × день» (B2B). Решение accept/reject
    // уже принято периодным бакетом выше (had), поэтому здесь просто дублируем.
    if (wantManagerTime) {
      const mdKey = `${mgrKey}::${toBerlinCivil(row.callCreatedAt)}`;
      if (!managerDayAccMap.has(mdKey)) managerDayAccMap.set(mdKey, newAcc());
      const mdAcc = managerDayAccMap.get(mdKey)!;
      // Отдельный аккумулятор на ЭТОТ звонок — считаем тем же путём, что и
      // дневной бакет, чтобы строка звонка сходилась со своим днём.
      const callAcc = newAcc();
      if (isAllFunnels) {
        const funnel = funnelLabelForOkk(department, row.promptType);
        processCallAsFunnel(mdAcc, row.totalScore, funnel);
        processCallAsFunnel(callAcc, row.totalScore, funnel);
      } else {
        processBlocks(blocks, mdAcc, row.totalScore);
        processBlocks(blocks, callAcc, row.totalScore);
        if (useSpellit) {
          accumulateClientScoring(evalJson, mdAcc);
          accumulateClientScoring(evalJson, callAcc);
          regroupAccToSpellit(callAcc);
        }
      }
      const cAgg = aggAccs([callAcc]);
      const list = managerDayCallsMap.get(mdKey) ?? [];
      list.push({
        callId: row.callId,
        startedAt: row.callCreatedAt.toISOString(),
        durationSec: row.durationSeconds,
        direction: row.direction,
        kommoLeadId: row.kommoLeadId,
        kommoLeadUrl: row.kommoLeadUrl
          ?? (row.kommoLeadId ? `https://${KOMMO.host}/leads/detail/${row.kommoLeadId}` : null),
        callCount: 1,
        overall: cAgg.overall,
        scores: cAgg.scores,
      });
      managerDayCallsMap.set(mdKey, list);
    }
  }

  // Pull names for every managerId that produced data — including inactive
  // (fired) managers and admins — so the breakdown table matches the
  // per-period totals. Active managers come from `managers` (drives the
  // dropdown); inactive/admin/etc. are loaded as `extras` here.
  const knownIds = new Set(managers.map((m) => m.id));
  const missingIds = [...managerAccMap.keys()].filter(
    (id) => id !== NO_MANAGER_KEY && !knownIds.has(id),
  );
  let extras: Array<{ id: string; name: string; isActive: boolean | null; role: string | null }> = [];
  if (missingIds.length > 0) {
    extras = await db
      .select({
        id: okkManagers.id,
        name: okkManagers.name,
        isActive: okkManagers.isActive,
        role: okkManagers.role,
      })
      .from(okkManagers)
      .where(inArray(okkManagers.id, missingIds));
  }
  // extras теперь — только активные менеджеры с данными, не попавшие в дропдаун
  // (уволенные отфильтрованы ещё на уровне выборки звонков по okkManagers.isActive),
  // поэтому метку «(уволен)» больше не добавляем.
  const allManagersForBreakdown: Array<{ id: string; name: string }> = [
    ...managers,
    ...extras.map((e) => ({ id: e.id, name: e.name })),
  ];
  if (managerAccMap.has(NO_MANAGER_KEY)) {
    allManagersForBreakdown.push({ id: NO_MANAGER_KEY, name: "Без менеджера" });
  }

  // In funnels mode the left column is the dept's funnel list (no criteria);
  // in criteria mode it's the JSON-canonical block/criteria for the selected
  // prompt_type(s).
  let canonical: CanonicalCriteria;
  if (isAllFunnels) {
    const funnels = funnelOrderForOkk(department);
    canonical = {
      blockOrder: funnels,
      blockCriteria: new Map(funnels.map((n) => [n, [] as string[]])),
      validKeys: new Set(),
    };
  } else {
    const promptTypesForCanonical = promptTypes ?? getLines(department).map((l) => l.promptType);
    canonical = await loadCanonicalCriteria(promptTypesForCanonical, useSpellit, useSpellit);
    if (useSpellit) regroupAllToSpellit(accMap, managerAccMap, managerDayAccMap);
  }

  return buildResponse(periods, accMap, managers, managerAccMap, "okk", department, processedCount, allManagersForBreakdown, canonical, managerDayAccMap, managerDayCallsMap);
}

// ─── Roleplay data fetcher ──────────────────────────────────

function getRoleplayCallTypes(department: string, line: string): string[] | null {
  if (line === "all" || !line) return null;
  if (department === "b2b") return null; // B2B has one script
  switch (line) {
    case "1": return ["qualifier"];
    case "2":
    case "2a":
    case "2b": return ["berater"]; // roleplay doesn't distinguish berater/berater2
    case "3": return ["dovedenie"];
    default: return null;
  }
}

async function fetchRoleplayData(
  department: "b2g" | "b2b",
  line: string,
  from: Date,
  to: Date,
  fromCivil: string,
  toCivil: string,
  groupBy: string,
  managerIds: string[],
  wantTree: boolean,
  excludedCallIds: Set<string>,
): Promise<AnalyticsResponse> {
  const db = getDbForDepartment(department);
  const callsTable = department === "b2b" ? r1Calls : d1Calls;
  const usersTable = department === "b2b" ? r1Users : d1Users;

  const callTypes = getRoleplayCallTypes(department, line);

  const conditions = [
    gte(callsTable.startedAt, from),
    lte(callsTable.startedAt, to),
    isNotNull(callsTable.score),
    isNotNull(callsTable.evaluationJson),
  ];
  if (callTypes && callTypes.length > 0) {
    conditions.push(inArray(callsTable.callType, callTypes));
  }
  if (managerIds.length) {
    conditions.push(inArray(callsTable.userId, managerIds));
  }

  // Manager dropdown — full active roster (see OKK comment). Same rationale.
  const managerConditions = [
    eq(usersTable.isActive, true),
    sql`${usersTable.role} IN ('manager', 'teamlead', 'rop')`,
  ];

  const [rows, managers] = await Promise.all([
    db
      .select({
        callId: callsTable.id,
        startedAt: callsTable.startedAt,
        durationSeconds: callsTable.durationSeconds,
        score: callsTable.score,
        evaluationJson: callsTable.evaluationJson,
        userId: callsTable.userId,
        callType: callsTable.callType,
      })
      .from(callsTable)
      .where(and(...conditions))
      .orderBy(callsTable.startedAt),
    db
      .select({ id: usersTable.id, name: usersTable.name })
      .from(usersTable)
      .where(and(...managerConditions)),
  ]);

  const periods = buildPeriodRange(fromCivil, toCivil, groupBy);
  const accMap = new Map<string, PeriodAcc>();
  for (const p of periods) accMap.set(p, newAcc());

  const managerAccMap = new Map<string, PeriodAcc>();

  // B2B-ролевки = единственный скрипт (оцениваются движком-портом ОКК по
  // r2_commercial) → всегда criteria-режим, чтобы показывать те же критерии,
  // что и у реальных звонков ОКК. B2G-ролевки сохраняют funnels/per-line логику.
  const isAllFunnels = department === "b2b" ? false : (line === "all" || !line);

  // B2B: аккумулятор «менеджер × день» для дерева неделя→менеджер→дата.
  // Ключ — civil-день (см. fetchOkkData): дерево не зависит от groupBy.
  const managerDayAccMap = new Map<string, PeriodAcc>();
  // 4-й уровень дерева: список ролевок на бакет «менеджер::день». В отличие от
  // ОКК у ролевок нет kommo-сделки и направления — звонок несёт только аудио и
  // транскрипт (читаются модалкой из R1/D1), kommoLead* остаются null, поэтому
  // секции «Открыть в Kommo» / «Ссылка на сделку» в меню не рендерятся.
  const managerDayCallsMap = new Map<string, TimeTreeCall[]>();
  const wantManagerTime = department === "b2b" && wantTree;

  let processedCount = 0;
  for (const row of rows) {
    if (!row.startedAt) continue;
    // Moderator-excluded roleplays are dropped entirely (see fetchOkkData).
    if (excludedCallIds.has(row.callId)) continue;
    const evalJson = row.evaluationJson as Record<string, unknown> | null;
    const blocks = evalJson && Array.isArray(evalJson.blocks) ? evalJson.blocks : null;
    if (!blocks || blocks.length === 0) continue;

    const p = toPeriodKey(row.startedAt, groupBy);
    const acc = accMap.get(p);
    if (!acc) continue;

    // See reconciliation note in fetchOkkData — manager bucket follows the
    // period bucket's accept/reject decision.
    let had: boolean;
    if (isAllFunnels) {
      const funnel = funnelLabelForRoleplay(department, row.callType);
      had = processCallAsFunnel(acc, row.score ?? null, funnel);
    } else {
      had = processBlocks(blocks, acc, row.score ?? null);
    }
    if (!had) continue;
    processedCount++;

    const mgrKey = row.userId ?? NO_MANAGER_KEY;
    if (!managerAccMap.has(mgrKey)) managerAccMap.set(mgrKey, newAcc());
    if (isAllFunnels) {
      const funnel = funnelLabelForRoleplay(department, row.callType);
      processCallAsFunnel(managerAccMap.get(mgrKey)!, row.score ?? null, funnel);
    } else {
      processBlocks(blocks, managerAccMap.get(mgrKey)!, row.score ?? null);
    }

    // Тот же звонок → бакет «менеджер × день» (B2B). См. fetchOkkData.
    if (wantManagerTime) {
      const mdKey = `${mgrKey}::${toBerlinCivil(row.startedAt)}`;
      if (!managerDayAccMap.has(mdKey)) managerDayAccMap.set(mdKey, newAcc());
      const mdAcc = managerDayAccMap.get(mdKey)!;
      // Отдельный аккумулятор на ЭТОТ звонок — тем же путём, что и дневной
      // бакет, чтобы строка звонка сходилась со своим днём (см. fetchOkkData).
      const callAcc = newAcc();
      if (isAllFunnels) {
        const funnel = funnelLabelForRoleplay(department, row.callType);
        processCallAsFunnel(mdAcc, row.score ?? null, funnel);
        processCallAsFunnel(callAcc, row.score ?? null, funnel);
      } else {
        processBlocks(blocks, mdAcc, row.score ?? null);
        processBlocks(blocks, callAcc, row.score ?? null);
        if (department === "b2b") regroupAccToSpellit(callAcc);
      }
      const cAgg = aggAccs([callAcc]);
      const list = managerDayCallsMap.get(mdKey) ?? [];
      list.push({
        callId: row.callId,
        startedAt: row.startedAt.toISOString(),
        durationSec: row.durationSeconds,
        direction: null,       // ролевка — нет inbound/outbound
        kommoLeadId: null,     // нет kommo-сделки
        kommoLeadUrl: null,
        callCount: 1,
        overall: cAgg.overall,
        scores: cAgg.scores,
      });
      managerDayCallsMap.set(mdKey, list);
    }
  }

  // See fetchOkkData — pull names for inactive/admin users that produced
  // data so per-manager sums match per-period sums.
  const knownIds = new Set(managers.map((m) => m.id));
  const missingIds = [...managerAccMap.keys()].filter(
    (id) => id !== NO_MANAGER_KEY && !knownIds.has(id),
  );
  let extras: Array<{ id: string; name: string; isActive: boolean | null }> = [];
  if (missingIds.length > 0) {
    extras = await db
      .select({
        id: usersTable.id,
        name: usersTable.name,
        isActive: usersTable.isActive,
      })
      .from(usersTable)
      .where(inArray(usersTable.id, missingIds));
  }
  // extras теперь — только активные менеджеры с данными, не попавшие в дропдаун
  // (уволенные отфильтрованы ещё на уровне выборки звонков по okkManagers.isActive),
  // поэтому метку «(уволен)» больше не добавляем.
  const allManagersForBreakdown: Array<{ id: string; name: string }> = [
    ...managers,
    ...extras.map((e) => ({ id: e.id, name: e.name })),
  ];
  if (managerAccMap.has(NO_MANAGER_KEY)) {
    allManagersForBreakdown.push({ id: NO_MANAGER_KEY, name: "Без менеджера" });
  }

  // Funnels mode → per-funnel canonical; criteria mode → dynamic (no JSON
  // config for roleplay yet, so we fall back to whatever evaluation_json
  // surfaces).
  let canonical: CanonicalCriteria;
  if (department === "b2b") {
    // Ролевки B2B оцениваются движком-портом ОКК по r2_commercial → грузим тот
    // же канонический набор критериев, что и у реальных звонков (Бух 1). Так
    // дерево показывает пооценочный разбор, согласованный с ОКК.
    canonical = await loadCanonicalCriteria(["r2_commercial"], true);
    regroupAllToSpellit(accMap, managerAccMap, managerDayAccMap);
  } else if (isAllFunnels) {
    const funnels = funnelOrderForRoleplay(department);
    canonical = {
      blockOrder: funnels,
      blockCriteria: new Map(funnels.map((n) => [n, [] as string[]])),
      validKeys: new Set(),
    };
  } else {
    canonical = EMPTY_CANONICAL;
  }
  // 4-й уровень (отдельные ролевки) заполнен только для B2B (wantManagerTime);
  // у ролевок нет kommo-сделки, поэтому в меню звонка доступны лишь
  // «Прослушать» / «Транскрипт» (читаются модалкой из R1/D1).
  return buildResponse(periods, accMap, managers, managerAccMap, "roleplay", department, processedCount, allManagersForBreakdown, canonical, managerDayAccMap, managerDayCallsMap);
}

// Roll up a set of per-(manager,day) accumulators into call-weighted scores.
// Summing raw scoreSum/count (not averaging pre-rounded values) keeps the
// week/manager aggregates correctly call-weighted — a manager with 1 call and
// one with 10 don't get equal weight. Keys: block name and "block::criterion";
// overall is the per-call total_score average. Used to build `timeTree`.
function aggAccs(accs: PeriodAcc[]): { overall: number | null; scores: Record<string, number>; callCount: number } {
  const blockSum = new Map<string, { s: number; c: number }>();
  const critSum = new Map<string, { s: number; c: number }>();
  let overSum = 0;
  let overCount = 0;
  let calls = 0;
  for (const a of accs) {
    calls += a.callCount;
    overSum += a.totalScoreSum;
    overCount += a.totalScoreCount;
    for (const [k, v] of a.blocks) { const e = blockSum.get(k) ?? { s: 0, c: 0 }; e.s += v.scoreSum; e.c += v.count; blockSum.set(k, e); }
    for (const [k, v] of a.criteria) { const e = critSum.get(k) ?? { s: 0, c: 0 }; e.s += v.scoreSum; e.c += v.count; critSum.set(k, e); }
  }
  const scores: Record<string, number> = {};
  for (const [k, v] of blockSum) if (v.c > 0) scores[k] = Math.round(v.s / v.c);
  for (const [k, v] of critSum) if (v.c > 0) scores[k] = Math.round(v.s / v.c);
  return { overall: overCount > 0 ? Math.round(overSum / overCount) : null, scores, callCount: calls };
}

// ─── Build response from accumulators ───────────────────────

function buildResponse(
  periods: string[],
  accMap: Map<string, PeriodAcc>,
  managers: Array<{ id: string; name: string }>,
  managerAccMap: Map<string, PeriodAcc>,
  source: string,
  department: string,
  totalCalls: number,
  managersForBreakdown: Array<{ id: string; name: string }> | undefined,
  canonical: CanonicalCriteria,
  managerDayAccMap: Map<string, PeriodAcc>,
  managerDayCallsMap: Map<string, TimeTreeCall[]>,
): AnalyticsResponse {
  // The dropdown stays scoped to active managers (`managers`); the breakdown
  // uses the full set including inactive/admin/"no-manager" so totals match.
  const breakdownSource = managersForBreakdown ?? managers;

  // Block/criteria order comes from the JSON config when we have one (every
  // OKK department covers it). Without canonical data (e.g. roleplay until
  // its criteria configs land) we fall back to dynamic collection so the
  // table still renders something.
  let blockOrder: string[];
  let blockCriteriaOrder: Map<string, string[]>;
  if (canonical.blockOrder.length > 0) {
    blockOrder = [...canonical.blockOrder];
    blockCriteriaOrder = new Map(canonical.blockCriteria);
  } else {
    blockOrder = [];
    blockCriteriaOrder = new Map<string, string[]>();
    for (const acc of [...accMap.values(), ...managerAccMap.values()]) {
      for (const bName of acc.blocks.keys()) {
        if (!blockOrder.includes(bName)) blockOrder.push(bName);
      }
      for (const key of acc.criteria.keys()) {
        const [bName, cName] = key.split("::");
        if (!blockCriteriaOrder.has(bName)) blockCriteriaOrder.set(bName, []);
        const arr = blockCriteriaOrder.get(bName)!;
        if (!arr.includes(cName)) arr.push(cName);
      }
    }
  }

  // Trim empty periods from the start (show data from first period with calls)
  let trimmedPeriods = periods;
  const firstNonEmpty = periods.findIndex((p) => {
    const acc = accMap.get(p);
    return acc && acc.callCount > 0;
  });
  if (firstNonEmpty > 0) {
    trimmedPeriods = periods.slice(firstNonEmpty);
  }

  // Period-based blocks (criteria × time) — use trimmed periods
  const blocks: BlockData[] = blockOrder.map((blockName) => {
    const scores: Record<string, number> = {};
    for (const p of trimmedPeriods) {
      const acc = accMap.get(p);
      const be = acc?.blocks.get(blockName);
      if (be && be.count > 0) scores[p] = Math.round(be.scoreSum / be.count);
    }

    const criteriaNames = blockCriteriaOrder.get(blockName) ?? [];
    const criteria: CriterionScore[] = criteriaNames.map((cName) => {
      const key = `${blockName}::${cName}`;
      const cScores: Record<string, number> = {};
      for (const p of trimmedPeriods) {
        const acc = accMap.get(p);
        const ce = acc?.criteria.get(key);
        if (ce && ce.count > 0) cScores[p] = Math.round(ce.scoreSum / ce.count);
      }
      return { name: cName, scores: cScores };
    });

    return { name: blockName, scores, criteria };
  });

  const overallScores: Record<string, number> = {};
  for (const p of trimmedPeriods) {
    const acc = accMap.get(p);
    if (acc && acc.totalScoreCount > 0) {
      overallScores[p] = Math.round(acc.totalScoreSum / acc.totalScoreCount);
    }
  }

  // Per-manager breakdown (aggregate across all periods). Uses the full
  // breakdown source (active + inactive-with-data + "Без менеджера") so the
  // sum of per-manager call counts equals `totalCalls`.
  const managerBreakdown: ManagerBreakdown[] = breakdownSource
    .map((mgr) => {
      const acc = managerAccMap.get(mgr.id);
      if (!acc || acc.callCount === 0) return null;

      const mgrBlocks: ManagerBlockScore[] = blockOrder.map((blockName) => {
        const be = acc.blocks.get(blockName);
        const blockScore = be && be.count > 0 ? Math.round(be.scoreSum / be.count) : null;

        const criteriaNames = blockCriteriaOrder.get(blockName) ?? [];
        const mgrCriteria: ManagerCriterionScore[] = criteriaNames.map((cName) => {
          const ce = acc.criteria.get(`${blockName}::${cName}`);
          return { name: cName, score: ce && ce.count > 0 ? Math.round(ce.scoreSum / ce.count) : null };
        });

        return { name: blockName, score: blockScore, criteria: mgrCriteria };
      });

      const overallScore = acc.totalScoreCount > 0 ? Math.round(acc.totalScoreSum / acc.totalScoreCount) : null;
      return { id: mgr.id, name: mgr.name, overallScore, callCount: acc.callCount, blocks: mgrBlocks };
    })
    .filter((m): m is ManagerBreakdown => m !== null)
    .sort((a, b) => (b.overallScore ?? 0) - (a.overallScore ?? 0));

  // B2B-only: дерево «неделя → менеджер → дата». Пусто, если managerDayAccMap
  // не заполнялся (не B2B). Колонки задаются blockOrder/blockCriteriaOrder на
  // фронте (ключи scores: имя блока и "блок::критерий"). Каждый уровень
  // агрегируется из сырых сумм/счётчиков → call-weighted (см. aggAccs).
  const nameById = new Map<string, string>(breakdownSource.map((m) => [m.id, m.name]));
  nameById.set(NO_MANAGER_KEY, "Без менеджера");

  // Группировка: неделя → менеджер → [дни].
  const weekMap = new Map<string, { label: string; mgrs: Map<string, Array<{ day: string; acc: PeriodAcc }>> }>();
  for (const [key, acc] of managerDayAccMap) {
    if (acc.callCount === 0) continue;
    const sep = key.lastIndexOf("::");
    const mgrKey = key.slice(0, sep);
    const day = key.slice(sep + 2);
    const { key: wk, label } = weekRange(day);
    let w = weekMap.get(wk);
    if (!w) { w = { label, mgrs: new Map() }; weekMap.set(wk, w); }
    let arr = w.mgrs.get(mgrKey);
    if (!arr) { arr = []; w.mgrs.set(mgrKey, arr); }
    arr.push({ day, acc });
  }

  const timeTree: TimeTreeWeek[] = [...weekMap.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([wk, w]) => {
      const allAccs: PeriodAcc[] = [];
      const managersArr: TimeTreeManager[] = [...w.mgrs.entries()]
        .sort((a, b) => (nameById.get(a[0]) ?? "").localeCompare(nameById.get(b[0]) ?? "", "ru"))
        .map(([mgrKey, days]) => {
          const mgrAccs = days.map((d) => d.acc);
          allAccs.push(...mgrAccs);
          const dates: TimeTreeDate[] = days
            .sort((a, b) => (a.day < b.day ? -1 : 1))
            .map((d) => {
              const agg = aggAccs([d.acc]);
              // Звонки этого дня (4-й уровень), по времени начала.
              const calls = (managerDayCallsMap.get(`${mgrKey}::${d.day}`) ?? [])
                .slice()
                .sort((a, b) => (a.startedAt ?? "").localeCompare(b.startedAt ?? ""));
              return { date: d.day, callCount: agg.callCount, overall: agg.overall, scores: agg.scores, calls };
            });
          const magg = aggAccs(mgrAccs);
          return { id: mgrKey, name: nameById.get(mgrKey) ?? "—", callCount: magg.callCount, overall: magg.overall, scores: magg.scores, dates };
        });
      const wagg = aggAccs(allAccs);
      return { key: wk, label: w.label, callCount: wagg.callCount, overall: wagg.overall, scores: wagg.scores, managers: managersArr };
    });

  // Diagnostic log
  console.log(`[Analytics] ${source}/${department}: ${totalCalls} calls, ${blockOrder.length} blocks, ${managers.length} managers in list, ${managerAccMap.size} managers with data`);
  for (const [mgrId, mgrAcc] of managerAccMap) {
    const inList = managers.some((m) => m.id === mgrId);
    if (mgrAcc.callCount > 0 && mgrAcc.blocks.size === 0) {
      console.warn(`[Analytics] Manager ${mgrId} has ${mgrAcc.callCount} calls but 0 blocks! inList=${inList}`);
    }
  }

  return { periods: trimmedPeriods, blocks, overallScores, managers, managerBreakdown, timeTree, totalCalls, source, department };
}

// ─── Excluded calls ─────────────────────────────────────────
//
// Calls a moderator removed from the stats (analytics_excluded_calls in D1).
// Loaded once per request and threaded into both fetchers; matching rows are
// dropped before any accumulation, so they neither show in the tree nor count
// toward any average. Signature is folded into the cache key so toggling an
// exclusion reflects on the next load (not after the 2-min TTL).
async function loadExcludedCallIds(department: string, source: string): Promise<Set<string>> {
  try {
    const rows = await db
      .select({ callId: analyticsExcludedCalls.callId })
      .from(analyticsExcludedCalls)
      .where(and(
        eq(analyticsExcludedCalls.department, department),
        eq(analyticsExcludedCalls.source, source),
      ));
    return new Set(rows.map((r) => r.callId));
  } catch (e) {
    console.warn("[Analytics] loadExcludedCallIds failed:", e instanceof Error ? e.message : e);
    return new Set();
  }
}

// ─── Route handler ──────────────────────────────────────────

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const sp = request.nextUrl.searchParams;
    const department = (sp.get("department") === "b2b" ? "b2b" : "b2g") as "b2g" | "b2b";
    const source = sp.get("source") === "roleplay" ? "roleplay" : "okk";
    const line = sp.get("line") ?? "all";
    const groupBy = sp.get("groupBy") ?? "day";
    const managerIdsParam = sp.get("managerIds");
    const managerIds = managerIdsParam ? managerIdsParam.split(",").filter(Boolean) : [];
    // tree=1 → строить дерево неделя→менеджер→дата (тяжёлое, нужно только для
    // B2B-детализации). Сводка (line=all) и режим сравнения его не запрашивают,
    // поэтому лишняя работа и payload не делаются.
    const wantTree = sp.get("tree") === "1";
    // minDur (сек) — фильтр минимальной длительности звонка. Используется
    // тумблером «≥ 15 мин (как в Spellit)» у Коммерсов; 0/пусто = без фильтра.
    const minDurRaw = Number.parseInt(sp.get("minDur") ?? "0", 10);
    const minDurSec = Number.isFinite(minDurRaw) && minDurRaw > 0 ? minDurRaw : 0;

    // Civil dates (YYYY-MM-DD) — what the user picks in the calendar — are
    // always interpreted as Berlin civil days here. Both the SQL filter and
    // the period-key bucketing run off the same Berlin window, so a 23:30
    // Berlin call lives in exactly one bucket and is included in exactly
    // one filter range.
    const todayC = todayCivil();
    const fromCivil = sp.get("from") || addDaysCivil(todayC, -30);
    const toCivil = sp.get("to") || todayC;

    const from = parseDateBoundary(fromCivil, "start");
    const to = parseDateBoundary(toCivil, "end");
    if (!from || !to) {
      return NextResponse.json({ success: false, error: "Invalid from/to" }, { status: 400 });
    }
    if (from > to) {
      return NextResponse.json({ success: false, error: "from must be before to" }, { status: 400 });
    }

    // Excluded calls (moderation): drop before aggregation. Signature in the
    // cache key so a freshly toggled exclusion isn't masked by the 2-min TTL.
    const excludedCallIds = await loadExcludedCallIds(department, source);
    const excludedSig = [...excludedCallIds].sort().join(",");

    const cacheKey = `analytics:${department}:${source}:${line}:${groupBy}:${fromCivil}:${toCivil}:${managerIds.join(",")}:tree=${wantTree}:minDur=${minDurSec}:excl=${excludedSig}`;

    const data = await cached(cacheKey, CACHE_TTL, () =>
      source === "roleplay"
        ? fetchRoleplayData(department, line, from, to, fromCivil, toCivil, groupBy, managerIds, wantTree, excludedCallIds)
        : fetchOkkData(department, line, from, to, fromCivil, toCivil, groupBy, managerIds, wantTree, excludedCallIds, minDurSec),
    );

    return NextResponse.json({ success: true, data });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal server error";
    console.error("[Analytics API]", error);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
