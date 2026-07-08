"use client";

import { useState, useEffect, useCallback, useRef, useMemo, Fragment } from "react";
import { RefreshCw, Loader2, ChevronDown, ChevronUp, ChevronsUpDown, ChevronsDownUp, ArrowLeftRight, ExternalLink, Copy, PhoneIncoming, PhoneOutgoing, Clock, Timer, Check, Search, X, Play, FileText, MoreHorizontal, Ban, RotateCcw, ListChecks } from "lucide-react";
import CalendarPicker, { type DateRange } from "@/components/CalendarPicker";
import DinoLoader from "@/components/DinoLoader";
import {
  fmtLocalDate,
  todayBerlinDate,
  berlinCivilDate,
  addDaysCivil,
  todayCivil,
} from "@/lib/utils/date";

// ==================== Types ====================

interface CriterionScore { name: string; displayName?: string; scores: Record<string, number> }
interface BlockData { name: string; scores: Record<string, number>; criteria: CriterionScore[] }
interface ManagerCriterion { name: string; score: number | null }
interface ManagerBlock { name: string; score: number | null; criteria: ManagerCriterion[] }
interface ManagerBreakdown { id: string; name: string; overallScore: number | null; callCount: number; blocks: ManagerBlock[] }
// B2B-only: дерево «неделя → менеджер → дата». overall = средний % за звонок;
// scores — баллы по колонкам (ключ = имя блока ИЛИ "блок::критерий").
interface TimeTreeNode { callCount: number; overall: number | null; scores: Record<string, number> }
// 4-й уровень — отдельный звонок/сделка. У ролевок kommoLead* = null (нет
// сделки) — в меню остаются только «Прослушать» / «Транскрипт».
interface TimeTreeCall extends TimeTreeNode {
  callId: string;
  startedAt: string | null;
  durationSec: number | null;
  direction: string | null;
  kommoLeadId: string | null;
  kommoLeadUrl: string | null;
}
interface TimeTreeDate extends TimeTreeNode { date: string; calls: TimeTreeCall[] }
interface TimeTreeManager extends TimeTreeNode { id: string; name: string; dates: TimeTreeDate[] }
interface TimeTreeWeek extends TimeTreeNode { key: string; label: string; managers: TimeTreeManager[] }
interface AnalyticsData {
  periods: string[];
  blocks: BlockData[];
  overallScores: Record<string, number>;
  managers: Array<{ id: string; name: string }>;
  managerBreakdown: ManagerBreakdown[];
  timeTree: TimeTreeWeek[];
  totalCalls: number;
}

// ==================== Helpers ====================

function getCriteriaColor(v: number | null | undefined): string {
  if (v === undefined || v === null) return "text-slate-600";
  if (v >= 80) return "text-emerald-400";
  if (v >= 50) return "text-amber-400";
  return "text-rose-400";
}

// Критерии с особой раскраской (канонические имена из src/criteria/*.json):
//  • ВСЕГДА инвертированные — сырой вердикт OKK уже означает «% плохого»
//    («Потеря клиента…»: 1 = клиент потерян), выше = хуже во всех вьюхах;
//  • инвертированные ТОЛЬКО в Spellit-виде — «Критические ошибки…»: сервер
//    переворачивает вердикт OKK («1 = ошибок не было») в «долю звонков с
//    ошибками» ТОЛЬКО в regroupAccToSpellit (Бух 1/Мед 1 + ролевки B2B).
//    На Бух 2 и всех B2G-таблицах значение остаётся прямым («% без ошибок»),
//    и красить его перевёрнутой шкалой нельзя — поэтому флаг spellitView
//    прокидывается от вьюхи (см. isSpellitView);
//  • нейтральные — информационная метрика без «хорошо/плохо» (talk ratio).
const ALWAYS_INVERTED_CRITERIA = new Set(["Потеря клиента на этапе оплаты"]);
const SPELLIT_INVERTED_CRITERIA = new Set([
  "Критические ошибки с точки зрения компании",
  "Критические ошибки с точки зрения клиента",
  "Критические ошибки с точки зрения закона",
]);
const NEUTRAL_CRITERIA = new Set(["Talk ratio Продавца"]);

// Зеркало серверного useSpellit (route.ts SPELLIT_PROMPT_TYPES + roleplay-B2B
// ветка): где сервер инвертировал «Критические ошибки», там и красим их как
// «% плохого».
function isSpellitView(department: "b2g" | "b2b", source: "okk" | "roleplay", line: string): boolean {
  if (department !== "b2b") return false;
  if (source === "roleplay") return true;
  return line === "buh1" || line === "med1";
}

// Скоринг клиента (Spellit-блок): сырые баллы, не проценты. Пороги окраски —
// как группы Spellit: отдельные скоринги 0–10 (≤5 / ≤7 / >7), итог 0–30
// (<10 / <20 / ≥20).
const CLIENT_SCORE_10 = new Set(["Потребность", "Платежеспособность", "Срочность"]);
const CLIENT_SCORE_TOTAL = "Итоговый скоринг";

function getClientScoreColor(name: string, v: number): string {
  if (name === CLIENT_SCORE_TOTAL) {
    return v >= 20 ? "text-emerald-400" : v >= 10 ? "text-amber-400" : "text-rose-400";
  }
  return v > 7 ? "text-emerald-400" : v > 5 ? "text-amber-400" : "text-rose-400";
}

function isClientScore(name: string): boolean {
  return name === CLIENT_SCORE_TOTAL || CLIENT_SCORE_10.has(name);
}

function isInvertedFor(name: string, spellitView: boolean): boolean {
  return ALWAYS_INVERTED_CRITERIA.has(name) || (spellitView && SPELLIT_INVERTED_CRITERIA.has(name));
}

function getCriteriaColorFor(name: string, v: number | null | undefined, spellitView = false): string {
  if (v === undefined || v === null) return "text-slate-600";
  if (NEUTRAL_CRITERIA.has(name)) return "text-slate-200";
  if (isClientScore(name)) return getClientScoreColor(name, v);
  if (isInvertedFor(name, spellitView)) return getCriteriaColor(100 - v);
  return getCriteriaColor(v);
}

function getCriteriaBgFor(name: string, v: number | null | undefined, spellitView = false): string {
  if (v === undefined || v === null) return "";
  if (NEUTRAL_CRITERIA.has(name)) return "";
  if (isClientScore(name)) return "";
  if (isInvertedFor(name, spellitView)) return getCriteriaBg(100 - v);
  return getCriteriaBg(v);
}

function getCriteriaBg(v: number | null | undefined): string {
  if (v === undefined || v === null) return "";
  if (v >= 80) return "bg-emerald-500/5";
  if (v >= 50) return "bg-amber-500/5";
  return "bg-rose-500/5";
}

function fmtScore(v: number | null | undefined): string {
  if (v === undefined || v === null) return "—";
  return `${v}%`;
}

// Скоринг клиента показываем сырым баллом (21, 8), остальное — процентом.
// Обязателен во ВСЕХ местах, где рендерится значение критерия по имени
// (таблицы динамики, разбивка по менеджерам, compare) — голый fmtScore
// пририсует «%» к сырым баллам скоринга.
function fmtScoreFor(name: string | null, v: number | null | undefined): string {
  if (v === undefined || v === null) return "—";
  if (name && isClientScore(name)) return String(v);
  return fmtScore(v);
}

// M:SS из секунд (длительность звонка).
function fmtDuration(sec: number | null | undefined): string {
  if (sec === undefined || sec === null) return "";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

// Время начала звонка ЧЧ:ММ в берлинской зоне (DST-aware).
function fmtBerlinTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Berlin" });
}

function fmtPeriod(p: string, g: string): string {
  if (g === "month") {
    const [y, m] = p.split("-");
    const mn = ["Янв", "Фев", "Мар", "Апр", "Май", "Июн", "Июл", "Авг", "Сен", "Окт", "Ноя", "Дек"];
    return `${mn[Number(m) - 1]} ${y.slice(2)}`;
  }
  if (g === "week") return p;
  const parts = p.split("-");
  if (parts.length === 3) return `${parts[2]}.${parts[1]}`;
  return p;
}

// Berlin civil "YYYY-MM-DD" — was using browser-local getFullYear/getMonth/
// getDate which silently shifted the day in non-Berlin browsers (US East
// pickers were dropping a full day before hitting the API).
function fmtDate(d: Date): string {
  return fmtLocalDate(d);
}

function fmtShortRange(r: DateRange): string {
  if (!r.start || !r.end) return "—";
  const f = (d: Date) => `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}`;
  return `${f(r.start)} – ${f(r.end)}`;
}

function avgScores(scores: Record<string, number>): number | null {
  const vals = Object.values(scores);
  if (vals.length === 0) return null;
  return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
}

function fmtDelta(a: number | null | undefined, b: number | null | undefined): string {
  if (a == null || b == null) return "—";
  const d = b - a;
  if (d === 0) return "0";
  return d > 0 ? `+${d}` : `${d}`;
}

function getDeltaColor(a: number | null | undefined, b: number | null | undefined): string {
  if (a == null || b == null) return "text-slate-600";
  const d = b - a;
  if (d > 0) return "text-emerald-400";
  if (d < 0) return "text-rose-400";
  return "text-slate-400";
}

// Line options sourced from tenant config so adding a line in one place
// (src/lib/config/tenant.ts) flows through to Analytics automatically.
import { getLines, isValidLineId } from "@/lib/config/tenant";

function getAnalyticsLines(
  dept: "b2g" | "b2b",
  vertical?: "buh" | "med" | "all",
): { id: string; label: string }[] {
  return getLines(dept, vertical).map((l) => ({ id: l.id, label: l.shortLabel ?? l.label }));
}

// Скрытые направления верхней сводки B2B (мультивыбор) — сохраняются между
// сессиями. Храним массив id скрытых линий.
const HIDDEN_DIRECTIONS_KEY = "sm_analytics_b2b_hidden_directions";

// ==================== Main Component ====================

// Дефолтный период по отделу. Коммерсы: «вчера» — РОП утром смотрит результаты
// прошлого дня (просьба владельца 2026-06-11). Госники: прежнее 30-дневное окно.
// Всё в Berlin-civil датах: browser-local `setDate(now − N)` давал рассинхрон
// на ±1 день с подсветкой пикера в не-берлинских браузерах.
function defaultDateRange(department: "b2g" | "b2b"): DateRange {
  if (department === "b2b") {
    const yesterday = berlinCivilDate(addDaysCivil(todayCivil(), -1));
    return { start: yesterday, end: yesterday };
  }
  const end = todayBerlinDate();
  const start = berlinCivilDate(addDaysCivil(todayCivil(), -30));
  return { start, end };
}

// Вытащить Kommo lead-id из вставленной строки. Поддерживает форматы:
//   .../leads/detail/12345678  /  .../leads/12345678  /  голый номер.
// Фолбэк — самая длинная группа цифр (≥4), чтобы ловить нестандартные URL.
function extractKommoLeadId(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  const m = s.match(/leads\/(?:detail\/)?(\d+)/);
  if (m) return m[1];
  const m2 = s.match(/(\d{4,})/);
  return m2 ? m2[1] : null;
}

interface ExcludedCall {
  id: string;
  callId: string;
  managerName: string | null;
  callDate: string | null;
  score: number | null;
  excludedByName: string | null;
  createdAt: string | null;
}

export default function AnalyticsTab({
  department,
  vertical,
  canModerate = false,
}: {
  department: "b2g" | "b2b";
  /** Вертикаль b2g из общего тоггла в шапке (buh/med/all). undefined на b2b.
   *  Применяется только к источнику OKK (мед-ролевок нет). */
  vertical?: "buh" | "med" | "all";
  canModerate?: boolean;
}) {
  const [source, setSource] = useState<"okk" | "roleplay">("okk");
  // Коммерсы: вид по вкладкам линий без «Все» → стартуем на первой линии.
  // Госники: кросс-воронка «Все» + опциональный per-line drill-down.
  const [line, setLine] = useState<string>(() => (department === "b2b" ? getLines("b2b")[0]?.id ?? "all" : "all"));
  // Вертикаль применима к линиям только для b2g+OKK. Нормализуем: 'all'/undefined
  // → показываем все линии (Бух+Мед); конкретную вертикаль — её линии.
  const lineVertical: "buh" | "med" | "all" =
    department === "b2g" && source === "okk" ? (vertical ?? "all") : "buh";
  const [groupBy, setGroupBy] = useState<"day" | "week" | "month">("day");
  const [managerIds, setManagerIds] = useState<string[]>([]);
  const [dateRange, setDateRange] = useState<DateRange>(() => defaultDateRange(department));
  // Тумблер «≥ 15 мин»: Spellit («Дашборд 1») пускает в таблицу только звонки
  // от 15 минут, OKK оценивает от 10 — включается для сверки цифр со Spellit.
  const [spellitMinDur, setSpellitMinDur] = useState(false);

  const [data, setData] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [collapsedBlocks, setCollapsedBlocks] = useState<Set<string>>(new Set());
  const [collapsedMgrBlocks, setCollapsedMgrBlocks] = useState<Set<string>>(new Set());
  // B2B-дерево: раскрытые недели (ключ = week.key) и менеджеры (ключ = "week::mgrId").
  const [expandedWeeks, setExpandedWeeks] = useState<Set<string>>(new Set());
  const [expandedMgrs, setExpandedMgrs] = useState<Set<string>>(new Set());
  const [expandedDates, setExpandedDates] = useState<Set<string>>(new Set());
  // Поиск строки по ссылке из Kommo: поле, подсвеченные звонки, статус.
  const [findLink, setFindLink] = useState("");
  const [highlightedCallIds, setHighlightedCallIds] = useState<Set<string>>(new Set());
  const [findStatus, setFindStatus] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  // B2B OKK: верхняя сводка «Динамика по критериям» — все линии (воронки) × даты.
  // Отдельный fetch line="all", не зависит от выбранной вкладки линии.
  const [overview, setOverview] = useState<AnalyticsData | null>(null);
  // Скрытые направления в сводке (мультивыбор). Храним id скрытых линий; читаем
  // из localStorage в эффекте (а не в инициализаторе) — гидрация цела.
  const [hiddenDirections, setHiddenDirections] = useState<Set<string>>(new Set());

  // Moderation: calls excluded from the stats (admin/rop only).
  // excludedList drives the «Исключённые» panel; excludeBusy guards double-clicks.
  const [excludedList, setExcludedList] = useState<ExcludedCall[]>([]);
  const [excludedOpen, setExcludedOpen] = useState(false);
  const [excludeBusy, setExcludeBusy] = useState(false);

  // Comparison mode
  const [compareMode, setCompareMode] = useState(false);
  const [compareDateRange, setCompareDateRange] = useState<DateRange>(() => {
    // Compare window = 30-day window ending 30 days ago, Berlin civil.
    const today = todayCivil();
    const end = berlinCivilDate(addDaysCivil(today, -30));
    const start = berlinCivilDate(addDaysCivil(today, -60));
    return { start, end };
  });
  const [compareData, setCompareData] = useState<AnalyticsData | null>(null);
  const [compareLoading, setCompareLoading] = useState(false);
  const [collapsedCompareBlocks, setCollapsedCompareBlocks] = useState<Set<string>>(new Set());
  const [collapsedCompareMgrBlocks, setCollapsedCompareMgrBlocks] = useState<Set<string>>(new Set());

  const toggle = (set: React.Dispatch<React.SetStateAction<Set<string>>>, name: string) => {
    set((prev) => { const n = new Set(prev); if (n.has(name)) n.delete(name); else n.add(name); return n; });
  };

  // Скролл к строке звонка. Двигаем ТОЛЬКО ближайший вертикальный скролл-
  // контейнер таблицы — не нативный scrollIntoView: он пузырём прокручивает и
  // внешний layout с overflow-hidden (page.tsx), из-за чего дашборд "уезжает"
  // вниз без возможности вернуться.
  const scrollToCall = useCallback((callId: string) => {
    const el = document.getElementById(`okk-call-${callId}`);
    if (!el) return;
    let scroller: HTMLElement | null = el.parentElement;
    while (scroller) {
      const oy = getComputedStyle(scroller).overflowY;
      if ((oy === "auto" || oy === "scroll") && scroller.scrollHeight > scroller.clientHeight) break;
      scroller = scroller.parentElement;
    }
    if (scroller) {
      const elRect = el.getBoundingClientRect();
      const scRect = scroller.getBoundingClientRect();
      const delta = (elRect.top - scRect.top) - (scroller.clientHeight - el.offsetHeight) / 2;
      scroller.scrollBy({ top: delta, behavior: "smooth" });
    } else {
      el.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, []);

  // Все ключи узлов дерева (недели / менеджеры / даты) — для кнопки «Развернуть
  // всё». Раскрытие всех веток нужно, чтобы полные ссылки звонков попали в DOM
  // и нативный поиск браузера (Ctrl+F) их нашёл — кросс-браузерно, без хаков.
  const allTreeKeys = useMemo(() => {
    const weeks = new Set<string>(), mgrs = new Set<string>(), dates = new Set<string>();
    if (data) for (const wk of data.timeTree) {
      weeks.add(wk.key);
      for (const mgr of wk.managers) {
        const mgrKey = `${wk.key}::${mgr.id}`;
        mgrs.add(mgrKey);
        for (const d of mgr.dates) dates.add(`${mgrKey}::${d.date}`);
      }
    }
    return { weeks, mgrs, dates };
  }, [data]);

  const allExpanded = allTreeKeys.dates.size > 0 && expandedDates.size >= allTreeKeys.dates.size;
  const toggleExpandAll = () => {
    if (allExpanded) {
      setExpandedWeeks(new Set());
      setExpandedMgrs(new Set());
      setExpandedDates(new Set());
    } else {
      setExpandedWeeks(new Set(allTreeKeys.weeks));
      setExpandedMgrs(new Set(allTreeKeys.mgrs));
      setExpandedDates(new Set(allTreeKeys.dates));
    }
  };

  // Найти строку звонка по ссылке из Kommo: парсим lead-id, ищем совпадения в
  // дереве, раскрываем путь (неделя → менеджер → дата), подсвечиваем строки и
  // прокручиваем к первой. Работает по уже загруженному data.timeTree — если
  // сделки нет в текущей выборке (другая линия/период/фильтр), скажем об этом.
  const findByLink = () => {
    const leadId = extractKommoLeadId(findLink);
    if (!leadId) { setFindStatus({ kind: "error", text: "Не похоже на ссылку Kommo" }); return; }
    if (!data) return;
    const weeks = new Set<string>(), mgrs = new Set<string>(), dates = new Set<string>(), calls = new Set<string>();
    for (const wk of data.timeTree) {
      for (const mgr of wk.managers) {
        for (const d of mgr.dates) {
          for (const c of d.calls) {
            const hit = c.kommoLeadId === leadId || (c.kommoLeadUrl?.includes(leadId) ?? false);
            if (!hit) continue;
            const mgrKey = `${wk.key}::${mgr.id}`;
            weeks.add(wk.key);
            mgrs.add(mgrKey);
            dates.add(`${mgrKey}::${d.date}`);
            calls.add(c.callId);
          }
        }
      }
    }
    if (calls.size === 0) {
      setHighlightedCallIds(new Set());
      setFindStatus({ kind: "error", text: "Сделка не найдена в текущей выборке (проверьте линию/период)" });
      return;
    }
    setExpandedWeeks((prev) => new Set([...prev, ...weeks]));
    setExpandedMgrs((prev) => new Set([...prev, ...mgrs]));
    setExpandedDates((prev) => new Set([...prev, ...dates]));
    setHighlightedCallIds(calls);
    setFindStatus({ kind: "ok", text: `Найдено строк: ${calls.size}` });
    // Скролл к первой строке — после того как раскрытие отрисуется.
    const first = [...calls][0];
    setTimeout(() => scrollToCall(first), 120);
  };

  const clearFind = () => {
    setFindLink("");
    setHighlightedCallIds(new Set());
    setFindStatus(null);
  };

  // Переключить видимость направления в сводке + сохранить выбор.
  const toggleDirection = (id: string) => {
    setHiddenDirections((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      try { window.localStorage.setItem(HIDDEN_DIRECTIONS_KEY, JSON.stringify([...next])); } catch { /* localStorage недоступен — не критично */ }
      return next;
    });
  };

  // Reset manager when context changes (different DB/line = different manager UUIDs)
  useEffect(() => {
    // Дефолт линии при смене отдела: Коммерсы стартуют на первой линии (вид по
    // вкладкам без «Все»); Госники — кросс-воронка «Все» (drill-down опционален).
    setLine(department === "b2b" ? getLines("b2b")[0]?.id ?? "all" : "all");
    setManagerIds([]);
    // Период тоже отдело-зависимый (b2b «вчера» / b2g 30 дней) — иначе при
    // переключении отдела остаётся дефолт того, с которого открыли вкладку.
    // Возвращаем prev, если даты совпали (эффект срабатывает и на маунте —
    // новый объект с теми же датами дал бы лишний повторный fetch).
    setDateRange((prev) => {
      const next = defaultDateRange(department);
      const same =
        prev.start?.getTime() === next.start?.getTime() &&
        prev.end?.getTime() === next.end?.getTime();
      return same ? prev : next;
    });
  }, [department]);
  useEffect(() => {
    setManagerIds([]);
    if (department === "b2b") {
      // Коммерсы: OKK — по вкладкам линий (Бух1/Бух2/Мед1, без «Все»); ролевки —
      // один скрипт (line="all"). Нормализуем line под выбранный источник.
      if (source === "roleplay") {
        if (line !== "all") setLine("all");
      } else if (!isValidLineId(department, line)) {
        setLine(getLines(department)[0]?.id ?? "all");
      }
      return;
    }
    // B2G: при переключении на ролевки схлопываем под-линии в группу (ролевки
    // не размечены под-линией, напр. "2b" → "2"). "all" не трогаем.
    if (source === "roleplay" && line !== "all") {
      // Мед-линий в ролевках нет — сбрасываем на «Все», иначе выбор «повиснет».
      const isMedLine = getLines(department, "med").some((l) => l.id === line);
      if (isMedLine) { setLine("all"); return; }
      const current = getLines(department).find((l) => l.id === line);
      if (current && current.id !== current.group) setLine(current.group);
    }
  }, [source, line, department]);
  // При смене вертикали в верхнем тоггле (b2g+OKK) выбранная линия может уйти из
  // видимого набора (напр. был "med2a", переключили на Бух) — сбрасываем на «Все».
  useEffect(() => {
    if (department !== "b2g" || source !== "okk" || line === "all") return;
    const visible = getLines(department, vertical ?? "all").some((l) => l.id === line);
    if (!visible) { setLine("all"); setManagerIds([]); }
  }, [vertical, department, source, line]);
  // If selected manager is not in current list, clear selection
  useEffect(() => {
    if (managerIds.length && data?.managers) {
      const valid = new Set(data.managers.map((m) => m.id));
      const filtered = managerIds.filter((id) => valid.has(id));
      if (filtered.length !== managerIds.length) setManagerIds(filtered);
    }
  }, [data?.managers, managerIds]);

  const buildParams = useCallback((range: DateRange) => {
    const fromStr = range.start ? fmtDate(range.start) : "";
    const toStr = range.end ? fmtDate(range.end) : "";
    if (!fromStr || !toStr) return null;
    // Roleplay calls aren't tagged with the B2G sub-line, so collapse both
    // 2a/2b → "2" before hitting the API. The collapse effect also runs but
    // is async; doing it here too eliminates the race-window.
    const effectiveLine = source === "roleplay" && (line === "2a" || line === "2b") ? "2" : line;
    const params = new URLSearchParams({ department, source, line: effectiveLine, groupBy, from: fromStr, to: toStr });
    // Вертикаль шлём только для b2g+OKK (мед-ролевок пока нет; b2b без вертикали).
    if (department === "b2g" && source === "okk" && vertical) params.set("vertical", vertical);
    if (managerIds.length) params.set("managerIds", managerIds.join(","));
    if (department === "b2b" && source === "okk" && spellitMinDur) params.set("minDur", "900");
    return params;
  }, [department, source, line, groupBy, managerIds, vertical, spellitMinDur]);

  // Loading-state toggle uses a ref so it doesn't end up in the deps array
  // — having `data` as a dep caused fetchData to get a new identity after
  // every successful response, which re-fired the effect and hammered the
  // API in a tight refetch loop.
  const hasDataRef = useRef(false);
  const fetchData = useCallback(async (signal?: AbortSignal) => {
    if (!hasDataRef.current) setLoading(true);
    setError(null);
    try {
      const params = buildParams(dateRange);
      if (!params) return;
      // Дерево неделя→менеджер→дата нужно только основному виду B2B; сводка
      // (line=all) и сравнение его не запрашивают (см. fetchOverview/fetchCompareData).
      if (department === "b2b") params.set("tree", "1");
      const res = await fetch(`/api/analytics?${params}`, { signal });
      if (!res.ok) throw new Error(`API error ${res.status}`);
      const json = await res.json();
      if (!json.success) throw new Error(json.error || "Unknown error");
      setData(json.data);
      hasDataRef.current = true;
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [buildParams, dateRange, department]);

  const fetchCompareData = useCallback(async (signal?: AbortSignal) => {
    if (!compareMode) return;
    setCompareLoading(true);
    try {
      const params = buildParams(compareDateRange);
      if (!params) return;
      const res = await fetch(`/api/analytics?${params}`, { signal });
      if (!res.ok) throw new Error(`API error ${res.status}`);
      const json = await res.json();
      if (!json.success) throw new Error(json.error || "Unknown error");
      setCompareData(json.data);
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
    } finally {
      setCompareLoading(false);
    }
  }, [buildParams, compareDateRange, compareMode]);

  // B2B OKK overview (line="all") — независимо от выбранной вкладки линии.
  // Самодостаточный гард: для не-B2B/не-OKK/compare очищает overview.
  const fetchOverview = useCallback(async (signal?: AbortSignal) => {
    if (department !== "b2b" || source !== "okk" || compareMode) { setOverview(null); return; }
    const fromStr = dateRange.start ? fmtDate(dateRange.start) : "";
    const toStr = dateRange.end ? fmtDate(dateRange.end) : "";
    if (!fromStr || !toStr) return;
    // Сводка всегда по дням (переключателя у Коммерсов нет) — колонки-даты.
    const params = new URLSearchParams({ department, source, line: "all", groupBy: "day", from: fromStr, to: toStr });
    if (managerIds.length) params.set("managerIds", managerIds.join(","));
    try {
      const res = await fetch(`/api/analytics?${params}`, { signal });
      if (!res.ok) throw new Error(`API error ${res.status}`);
      const json = await res.json();
      if (json.success) setOverview(json.data);
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
    }
  }, [department, source, compareMode, dateRange, managerIds]);

  // Moderation: current exclusions for the panel (admin/rop only).
  const fetchExcluded = useCallback(async (signal?: AbortSignal) => {
    if (!canModerate) { setExcludedList([]); return; }
    try {
      const res = await fetch(`/api/analytics/exclude?department=${department}&source=${source}`, { signal });
      if (!res.ok) return;
      const json = await res.json();
      if (Array.isArray(json.excluded)) setExcludedList(json.excluded as ExcludedCall[]);
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
    }
  }, [canModerate, department, source]);

  // Exclude (true) / restore (false) a call, then recompute stats + refresh
  // the panel. The /api/analytics cache key folds in the exclusion signature,
  // so the refetch returns freshly-recomputed averages (no TTL lag).
  const toggleExclude = useCallback(async (
    callId: string,
    excluded: boolean,
    meta?: { managerName?: string; callDate?: string; score?: number | null },
  ) => {
    if (!canModerate || excludeBusy) return;
    setExcludeBusy(true);
    try {
      const res = await fetch("/api/analytics/exclude", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ department, source, callId, excluded, ...meta }),
      });
      if (!res.ok) throw new Error(`exclude failed ${res.status}`);
      hasDataRef.current = true; // background refresh — keep tree mounted
      await Promise.all([fetchData(), fetchOverview(), fetchExcluded()]);
    } catch (e) {
      console.error("[Analytics] toggleExclude:", e);
    } finally {
      setExcludeBusy(false);
    }
  }, [canModerate, excludeBusy, department, source, fetchData, fetchOverview, fetchExcluded]);

  useEffect(() => {
    const ac = new AbortController();
    fetchData(ac.signal);
    return () => ac.abort();
  }, [fetchData]);

  useEffect(() => {
    const ac = new AbortController();
    fetchExcluded(ac.signal);
    return () => ac.abort();
  }, [fetchExcluded]);

  useEffect(() => {
    const ac = new AbortController();
    fetchOverview(ac.signal);
    return () => ac.abort();
  }, [fetchOverview]);

  // Восстановить скрытые направления из localStorage (один раз, на маунте).
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(HIDDEN_DIRECTIONS_KEY);
      if (!raw) return;
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        setHiddenDirections(new Set(arr.filter((x: unknown): x is string => typeof x === "string")));
      }
    } catch { /* битый JSON / нет доступа — игнорируем */ }
  }, []);

  useEffect(() => {
    if (!compareMode) { setCompareData(null); return; }
    const ac = new AbortController();
    fetchCompareData(ac.signal);
    return () => ac.abort();
  }, [fetchCompareData, compareMode]);

  const periods = data?.periods ?? [];
  const isCompareReady = compareMode && data && compareData;

  // Видимые направления сводки (скрытые убираем из строк). «Средний балл» НЕ
  // пересчитываем — всегда серверный (call-weighted общий по отделу): скрытие
  // направления это фильтр строк, а не смена метрики. Иначе при скрытии число
  // прыгало с взвешенного на простое среднее (низкообъёмная воронка получала бы
  // тот же вес, что большая).
  const visibleOverviewBlocks = useMemo<BlockData[]>(() => {
    if (!overview) return [];
    const labelToId = new Map(getLines("b2b").map((l) => [l.shortLabel ?? l.label, l.id]));
    return overview.blocks.filter((b) => {
      const id = labelToId.get(b.name);
      return !id || !hiddenDirections.has(id);
    });
  }, [overview, hiddenDirections]);

  return (
    <div className="flex flex-col gap-5 fade-in flex-1 overflow-y-auto pb-6 scrollbar-hide">
      {/* ── Filters ── */}
      <div className="flex flex-wrap gap-2 items-center">
        {/* Source */}
        <div className="flex bg-slate-800/50 p-1 rounded-xl border border-white/5">
          {(["okk", "roleplay"] as const).map((s) => (
            <button key={s} onClick={() => setSource(s)}
              className={`px-3 py-1.5 rounded-lg text-[10px] uppercase tracking-widest font-bold transition-all ${
                source === s ? "bg-blue-500/20 text-blue-400 border border-blue-500/30" : "text-slate-400 hover:text-white"
              }`}>
              {s === "okk" ? "OKK" : "Ролевки"}
            </button>
          ))}
        </div>

        {/* Line filter (только Госники). Коммерсы выбирают линию вкладками над
            таблицей (без «Все»), поэтому здесь фильтр-бар их линий не показываем.
            Для ролевок под-линии схлопываются в группу ("2a"/"2b" → "2"), а
            ведущая «Все» агрегирует все воронки. */}
        {department !== "b2b" && (
          <div className="flex bg-slate-800/50 p-1 rounded-xl border border-white/5">
            <button onClick={() => { setLine("all"); setManagerIds([]); }}
              className={`px-2.5 py-1.5 rounded-lg text-[10px] uppercase tracking-widest font-bold transition-all ${
                line === "all" ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30" : "text-slate-400 hover:text-white"
              }`}>
              Все
            </button>
            {(() => {
              // OKK у Госников — линии выбранной вертикали (Бух/Мед/Все). Ролевки
              // и b2b — бух-дефолт (мед-ролевок нет). lineVertical это учитывает.
              const lines = getAnalyticsLines(department, lineVertical);
              // For roleplay, dedupe by group so each group shows once.
              if (source === "roleplay") {
                const seen = new Set<string>();
                const fullLines = getLines(department);
                return lines.filter((l) => {
                  const group = fullLines.find((fl) => fl.id === l.id)?.group ?? l.id;
                  if (seen.has(group)) return false;
                  seen.add(group);
                  return true;
                });
              }
              return lines;
            })().map((l) => (
              <button key={l.id} onClick={() => { setLine(l.id); setManagerIds([]); }}
                className={`px-2.5 py-1.5 rounded-lg text-[10px] uppercase tracking-widest font-bold transition-all ${
                  line === l.id ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30" : "text-slate-400 hover:text-white"
                }`}>
                {l.label}
              </button>
            ))}
          </div>
        )}

        {/* GroupBy — скрыт в режиме сравнения и у Коммерсов: у них сводка всегда
            по дням (колонки-даты), а дерево — неделя→день. Переключатель
            дни/нед/мес остаётся только у Госников. */}
        {!compareMode && department !== "b2b" && (
          <div className="flex bg-slate-800/50 p-1 rounded-xl border border-white/5">
            {(["day", "week", "month"] as const).map((g) => (
              <button key={g} onClick={() => setGroupBy(g)}
                className={`px-2.5 py-1.5 rounded-lg text-[10px] uppercase tracking-widest font-bold transition-all ${
                  groupBy === g ? "bg-purple-500/20 text-purple-400 border border-purple-500/30" : "text-slate-400 hover:text-white"
                }`}>
                {g === "day" ? "Дни" : g === "week" ? "Нед" : "Мес"}
              </button>
            ))}
          </div>
        )}

        {/* Calendar picker A */}
        <CalendarPicker
          mode="range"
          value={dateRange}
          onChange={setDateRange}
          onClear={() => setDateRange(defaultDateRange(department))}
        />

        {/* Compare toggle */}
        <button onClick={() => setCompareMode(!compareMode)}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-[10px] uppercase tracking-widest font-bold transition-all border ${
            compareMode
              ? "bg-orange-500/20 text-orange-400 border-orange-500/30"
              : "bg-slate-800/50 text-slate-400 border-white/5 hover:text-white"
          }`}>
          <ArrowLeftRight className="w-3.5 h-3.5" />
          Сравнить
        </button>

        {/* Calendar picker B — only in compare mode */}
        {compareMode && (
          <CalendarPicker
            mode="range"
            value={compareDateRange}
            onChange={setCompareDateRange}
            onClear={() => {
              const today = todayCivil();
              const end = berlinCivilDate(addDaysCivil(today, -30));
              const start = berlinCivilDate(addDaysCivil(today, -60));
              setCompareDateRange({ start, end });
            }}
          />
        )}

        {/* Manager dropdown */}
        {data?.managers && data.managers.length > 0 && (
          <ManagerMultiSelect managers={data.managers} selected={managerIds} onChange={setManagerIds} />
        )}

        {/* Refresh + count */}
        <button onClick={() => { fetchData(); fetchOverview(); if (compareMode) fetchCompareData(); }} disabled={loading}
          className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/5 disabled:opacity-30">
          <RefreshCw className={`w-3.5 h-3.5 ${loading || compareLoading ? "animate-spin" : ""}`} />
        </button>
        {data && <span className="text-[10px] text-slate-500">{data.totalCalls} зв.</span>}
        {compareMode && compareData && <span className="text-[10px] text-slate-500">vs {compareData.totalCalls} зв.</span>}
      </div>

      {/* Loading */}
      {loading && !data && <DinoLoader />}
      {(loading || compareLoading) && data && (
        <div className="flex items-center justify-center py-2">
          <div className="flex items-center gap-2 px-4 py-1.5 rounded-full bg-blue-500/10 border border-blue-500/20">
            <Loader2 className="w-3 h-3 animate-spin text-blue-400" />
            <span className="text-[10px] text-blue-400 font-medium">Обновление...</span>
          </div>
        </div>
      )}

      {error && (
        <div className="glass-panel rounded-2xl p-6 border border-red-500/20 bg-red-500/5">
          <p className="text-red-400 text-sm">{error}</p>
          <button onClick={() => fetchData()} className="mt-2 text-xs text-red-300 underline hover:text-white">Повторить</button>
        </div>
      )}

      {/* ── COMPARE MODE ── */}
      {isCompareReady ? (
        <>
          <div className="text-[11px] uppercase tracking-widest font-bold text-slate-500">
            Сравнение по критериям
          </div>
          <ComparisonCriteriaTable
            dataA={data}
            dataB={compareData}
            labelA={fmtShortRange(dateRange)}
            labelB={fmtShortRange(compareDateRange)}
            collapsedBlocks={collapsedCompareBlocks}
            onToggle={(n) => toggle(setCollapsedCompareBlocks, n)}
            spellitView={isSpellitView(department, source, line)}
          />

          {managerIds.length !== 1 &&(data.managerBreakdown.length > 0 || compareData.managerBreakdown.length > 0) && (
            <>
              <div className="text-[11px] uppercase tracking-widest font-bold text-slate-500 mt-2">
                Сравнение по менеджерам
              </div>
              <ComparisonManagerTable
                dataA={data}
                dataB={compareData}
                labelA={fmtShortRange(dateRange)}
                labelB={fmtShortRange(compareDateRange)}
                collapsedBlocks={collapsedCompareMgrBlocks}
                onToggle={(n) => toggle(setCollapsedCompareMgrBlocks, n)}
              />
            </>
          )}
        </>
      ) : department === "b2b" ? (
        /* B2B (Коммерсы): сверху сводка «Динамика по критериям» (все линии ×
           даты, line="all"), ниже — вкладки линий + дерево неделя→менеджер→дата
           по выбранной линии. См. dev_docs/13-РАЗДЕЛЕНИЕ-B2G-B2B.md §8. */
        <>
          {/* Верхняя сводка: воронки Бух1/Бух2/Мед1 × даты (отдельный fetch).
              Над таблицей — мультивыбор видимых направлений (сохраняется). */}
          {overview && overview.blocks.length > 0 && (
            <>
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="text-[11px] uppercase tracking-widest font-bold text-slate-500">
                  Динамика по критериям
                </div>
                <div className="flex items-center gap-1.5">
                  {getAnalyticsLines(department).map((l) => {
                    const on = !hiddenDirections.has(l.id);
                    return (
                      <button
                        key={l.id}
                        type="button"
                        onClick={() => toggleDirection(l.id)}
                        title={on ? "Скрыть направление" : "Показать направление"}
                        className={`px-2.5 py-1 rounded-lg text-[10px] uppercase tracking-widest font-bold border transition-all ${
                          on
                            ? "bg-blue-500/15 text-blue-300 border-blue-500/30"
                            : "bg-transparent text-slate-600 border-white/5 line-through"
                        }`}
                      >
                        {l.label}
                      </button>
                    );
                  })}
                </div>
              </div>
              {visibleOverviewBlocks.length > 0 ? (
                <CriteriaTimeTable
                  blocks={visibleOverviewBlocks}
                  periods={overview.periods}
                  groupBy="day"
                  overallScores={overview.overallScores}
                  collapsedBlocks={collapsedBlocks}
                  onToggle={(n) => toggle(setCollapsedBlocks, n)}
                  // Один видимый направление = строка направления уже равна
                  // среднему → прячем дублирующую строку «Средний балл».
                  showAverage={visibleOverviewBlocks.length > 1}
                />
              ) : (
                <div className="glass-panel rounded-2xl p-6 border border-white/5 text-center">
                  <p className="text-slate-500 text-sm">Все направления скрыты</p>
                </div>
              )}
            </>
          )}
          {/* Детализация по линии: вкладки (folder-tabs) вплотную над деревом. */}
          <div className="flex flex-col">
            {/* Поиск строки по ссылке из Kommo */}
            {data && data.timeTree.length > 0 && (
              <div className="flex items-center gap-2 mb-2 flex-wrap">
                <div className="relative flex-1 min-w-[240px] max-w-md">
                  <Search className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    type="text"
                    value={findLink}
                    onChange={(e) => setFindLink(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") findByLink(); }}
                    placeholder="Вставьте ссылку из Kommo, чтобы найти сделку в таблице..."
                    className="w-full bg-slate-800/50 border border-white/10 rounded-lg pl-8 pr-8 py-1.5 text-[11px] text-slate-200 placeholder-slate-500 focus:outline-none focus:border-blue-500/40"
                  />
                  {findLink && (
                    <button
                      onClick={clearFind}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-white"
                      title="Сбросить"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
                <button
                  onClick={findByLink}
                  disabled={!findLink.trim()}
                  className="px-3 py-1.5 rounded-lg bg-blue-500 hover:bg-blue-600 disabled:opacity-30 disabled:cursor-not-allowed text-white text-[11px] font-bold uppercase tracking-wider"
                >
                  Найти
                </button>
                {findStatus && (
                  <span className={`text-[11px] ${findStatus.kind === "ok" ? "text-emerald-400" : "text-amber-400"}`}>
                    {findStatus.text}
                  </span>
                )}
                {/* Развернуть всё — чтобы все строки (с полными ссылками) попали в
                    DOM и нашлись через нативный Ctrl+F в любом браузере. */}
                <button
                  onClick={toggleExpandAll}
                  className="ml-auto flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800/50 hover:bg-slate-700/50 border border-white/10 text-slate-300 text-[11px] font-bold uppercase tracking-wider"
                  title={allExpanded ? "Свернуть все ветки" : "Развернуть все ветки (для поиска через Ctrl+F)"}
                >
                  {allExpanded ? <ChevronsDownUp className="w-3.5 h-3.5" /> : <ChevronsUpDown className="w-3.5 h-3.5" />}
                  {allExpanded ? "Свернуть всё" : "Развернуть всё"}
                </button>
              </div>
            )}
            {/* Исключённые из статистики — панель модерации (admin/rop/teamlead). */}
            {canModerate && excludedList.length > 0 && (
              <div className="glass-panel rounded-2xl border border-rose-500/15 mb-2 overflow-hidden">
                <button
                  type="button"
                  onClick={() => setExcludedOpen((v) => !v)}
                  className="w-full flex items-center justify-between gap-2 px-4 py-2.5 hover:bg-white/[0.02]"
                >
                  <span className="flex items-center gap-2 text-[11px] uppercase tracking-widest font-bold text-rose-300">
                    <Ban className="w-3.5 h-3.5" />
                    Исключённые из статистики ({excludedList.length})
                  </span>
                  {excludedOpen ? <ChevronUp className="w-4 h-4 text-slate-500" /> : <ChevronDown className="w-4 h-4 text-slate-500" />}
                </button>
                {excludedOpen && (
                  <div className="px-3 pb-3 flex flex-col gap-1">
                    {excludedList.map((ex) => (
                      <div key={ex.id} className="flex items-center gap-2 text-[11px] text-slate-400 bg-slate-900/40 rounded-lg px-3 py-1.5">
                        <span className="text-slate-200 font-medium truncate max-w-[160px]">{ex.managerName ?? "—"}</span>
                        <span className="text-slate-600">·</span>
                        <span className="tabular-nums">{ex.callDate ?? "—"}</span>
                        {ex.score != null && (
                          <>
                            <span className="text-slate-600">·</span>
                            <span className="tabular-nums">{ex.score}%</span>
                          </>
                        )}
                        {ex.excludedByName && (
                          <span className="text-slate-600 truncate hidden sm:inline">· исключил: {ex.excludedByName}</span>
                        )}
                        <button
                          type="button"
                          disabled={excludeBusy}
                          onClick={() => toggleExclude(ex.callId, false)}
                          className="ml-auto shrink-0 flex items-center gap-1 px-2 py-1 rounded bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-300 font-semibold disabled:opacity-40"
                          title="Вернуть звонок в статистику"
                        >
                          <RotateCcw className="w-3 h-3" /> Вернуть
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            {source === "okk" && data && (
              <div className="flex items-end justify-between gap-3">
                <LineTabs lines={getAnalyticsLines(department)} active={line} onSelect={setLine} />
                {/* Паритет со Spellit: их «Дашборд 1» показывает только звонки ≥ 15 мин */}
                <label className="flex items-center gap-1.5 pb-1 cursor-pointer select-none text-[10px] uppercase tracking-wider font-semibold text-slate-400 hover:text-slate-200 whitespace-nowrap">
                  <input
                    type="checkbox"
                    checked={spellitMinDur}
                    onChange={(e) => setSpellitMinDur(e.target.checked)}
                    className="accent-blue-500 w-3 h-3"
                  />
                  ≥ 15 мин (как в Spellit)
                </label>
              </div>
            )}
            {data && data.timeTree.length > 0 ? (
              <CriteriaTimeTree
                tree={data.timeTree}
                blocks={data.blocks}
                department={department}
                source={source}
                spellitView={isSpellitView(department, source, line)}
                highlightedCallIds={highlightedCallIds}
                collapsedBlocks={collapsedMgrBlocks}
                onToggleBlock={(n) => toggle(setCollapsedMgrBlocks, n)}
                expandedWeeks={expandedWeeks}
                onToggleWeek={(k) => toggle(setExpandedWeeks, k)}
                expandedMgrs={expandedMgrs}
                onToggleMgr={(k) => toggle(setExpandedMgrs, k)}
                expandedDates={expandedDates}
                onToggleDate={(k) => toggle(setExpandedDates, k)}
                canModerate={canModerate}
                onExclude={(info) => toggleExclude(info.callId, true, { managerName: info.managerName, callDate: info.callDate, score: info.score })}
              />
            ) : (
              data && !loading ? (
                <div className="glass-panel rounded-2xl rounded-tl-none p-6 border border-white/5 text-center" style={{ marginTop: 1 }}>
                  <p className="text-slate-500 text-sm">Нет данных по выбранной линии за период</p>
                </div>
              ) : null
            )}
          </div>
        </>
      ) : (
        <>
          {/* ── NORMAL MODE (B2G): Table 1 — Criteria x Time ── */}
          {data && periods.length > 0 && (
            <>
              <div className="text-[11px] uppercase tracking-widest font-bold text-slate-500">
                Динамика по критериям
              </div>
              <CriteriaTimeTable
                blocks={data.blocks}
                periods={periods}
                groupBy={groupBy}
                overallScores={data.overallScores}
                collapsedBlocks={collapsedBlocks}
                onToggle={(n) => toggle(setCollapsedBlocks, n)}
              />
            </>
          )}

          {/* ── NORMAL MODE (B2G): Table 2 — разбивка по менеджерам ── */}
          {data && data.managerBreakdown.length > 0 && managerIds.length !== 1 &&(
            <>
              <div className="text-[11px] uppercase tracking-widest font-bold text-slate-500 mt-2">
                Разбивка по менеджерам
              </div>
              <ManagerTable
                blocks={data.blocks}
                managers={data.managerBreakdown}
                collapsedBlocks={collapsedMgrBlocks}
                onToggle={(n) => toggle(setCollapsedMgrBlocks, n)}
              />
            </>
          )}
        </>
      )}

      {data && !loading && data.totalCalls === 0 && department !== "b2b" && (
        <div className="glass-panel rounded-2xl p-8 border border-white/5 text-center">
          <p className="text-slate-500 text-sm">Нет данных за выбранный период</p>
        </div>
      )}
    </div>
  );
}

// ==================== Criteria x Time Table ====================

function CriteriaTimeTable({
  blocks, periods, groupBy, overallScores, collapsedBlocks, onToggle, showAverage = true,
}: {
  blocks: BlockData[]; periods: string[]; groupBy: string;
  overallScores: Record<string, number>;
  collapsedBlocks: Set<string>; onToggle: (n: string) => void;
  // «Средний балл» row. Hidden by the B2B overview when only one direction is
  // visible (the single direction row already equals the average).
  showAverage?: boolean;
}) {
  return (
    <div className="glass-panel text-slate-200 rounded-2xl border border-white/5 shadow-2xl">
      <div className="w-full rounded-2xl" style={{ overflowX: "auto", overflowY: "auto", maxHeight: "70vh" }}>
        <table className="w-full text-left border-collapse">
          <thead className="sticky top-0 z-40" style={{ backgroundColor: "rgb(15, 23, 42)", boxShadow: "0 2px 8px rgba(0,0,0,0.4)" }}>
            <tr className="light-panel-header border-b border-white/10">
              <th className="px-4 py-2.5 text-[10px] uppercase tracking-widest text-slate-500 font-semibold sticky left-0 z-50 min-w-[260px]" style={{ backgroundColor: "rgb(15, 23, 42)" }}>
                Критерий
              </th>
              {periods.map((p) => (
                <th key={p} className="px-2 py-2 text-center min-w-[50px]">
                  <div className="text-[9px] uppercase tracking-wider text-slate-400 font-bold">{fmtPeriod(p, groupBy)}</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="text-sm">
            {blocks.map((block) => {
              const collapsed = collapsedBlocks.has(block.name);
              return (
                <BlockTimeRows key={block.name} block={block} periods={periods} isCollapsed={collapsed} onToggle={() => onToggle(block.name)} />
              );
            })}
            {showAverage && (
              <tr className="border-t-2 border-white/10 bg-blue-500/[0.05]">
                <td className="px-4 py-2.5 font-bold text-white text-[12px] sticky left-0 bg-slate-900/90 backdrop-blur-sm z-10">Средний балл</td>
                {periods.map((p) => {
                  const v = overallScores[p];
                  return <td key={p} className={`px-2 py-2.5 text-right font-mono text-[12px] font-bold ${getCriteriaColor(v)} ${getCriteriaBg(v)}`}>{fmtScore(v)}</td>;
                })}
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function BlockTimeRows({ block, periods, isCollapsed, onToggle }: { block: BlockData; periods: string[]; isCollapsed: boolean; onToggle: () => void }) {
  // В режиме «Все» строка = воронка без критериев (API отдаёт criteria=[]
  // намеренно). Раскрывать нечего → убираем шеврон и клик у таких строк.
  const hasChildren = block.criteria.length > 0;
  return (
    <>
      <tr className={`bg-slate-900/60 border-t border-white/10 ${hasChildren ? "cursor-pointer hover:bg-slate-800/40" : ""}`} onClick={hasChildren ? onToggle : undefined}>
        <td className="px-4 py-2 sticky left-0 bg-slate-900/60 backdrop-blur-sm z-10">
          <div className="flex items-center gap-2">
            {hasChildren && (isCollapsed ? <ChevronDown className="w-3.5 h-3.5 text-slate-500" /> : <ChevronUp className="w-3.5 h-3.5 text-slate-500" />)}
            <span className="text-[11px] uppercase tracking-widest font-bold text-slate-300">{block.name}</span>
          </div>
        </td>
        {periods.map((p) => {
          const v = block.scores[p];
          return <td key={p} className={`px-2 py-2 text-right font-mono text-[11px] font-bold ${getCriteriaColor(v)} ${getCriteriaBg(v)}`}>{fmtScore(v)}</td>;
        })}
      </tr>
      {hasChildren && !isCollapsed && block.criteria.map((c) => (
        <tr key={`${block.name}-${c.name}`} className="hover:bg-white/[0.02] border-b border-white/[0.03]">
          <td className="px-4 py-1.5 text-[11px] text-slate-400 sticky left-0 bg-slate-900/90 backdrop-blur-sm z-10 pl-10">{c.name}</td>
          {periods.map((p) => {
            const v = c.scores[p];
            return <td key={p} className={`px-2 py-1.5 text-right font-mono text-[11px] ${getCriteriaColorFor(c.name, v)} ${getCriteriaBgFor(c.name, v)}`}>{fmtScoreFor(c.name, v)}</td>;
          })}
        </tr>
      ))}
    </>
  );
}

// ==================== Criteria x Managers Table ====================

function ManagerTable({
  blocks, managers, collapsedBlocks, onToggle,
}: {
  blocks: BlockData[]; managers: ManagerBreakdown[];
  collapsedBlocks: Set<string>; onToggle: (n: string) => void;
}) {
  return (
    <div className="glass-panel text-slate-200 rounded-2xl border border-white/5 shadow-2xl">
      <div className="w-full rounded-2xl" style={{ overflowX: "auto", overflowY: "auto", maxHeight: "70vh" }}>
        <table className="w-full text-left border-collapse">
          <thead className="sticky top-0 z-40" style={{ backgroundColor: "rgb(15, 23, 42)", boxShadow: "0 2px 8px rgba(0,0,0,0.4)" }}>
            <tr className="light-panel-header border-b border-white/10">
              <th className="px-4 py-2.5 text-[10px] uppercase tracking-widest text-slate-500 font-semibold sticky left-0 z-50 min-w-[260px]" style={{ backgroundColor: "rgb(15, 23, 42)" }}>
                Критерий
              </th>
              {managers.map((m) => (
                <th key={m.id} className="px-2 py-2 text-center min-w-[75px]">
                  <div className="text-[9px] uppercase tracking-wider text-slate-400 font-bold leading-tight whitespace-nowrap">{m.name}</div>
                  <div className="text-[11px] text-white font-bold">{m.callCount} зв.</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="text-sm">
            {blocks.map((block, bi) => {
              const collapsed = collapsedBlocks.has(block.name);
              return (
                <BlockManagerRows key={block.name} blockName={block.name} blockIdx={bi}
                  criteriaNames={block.criteria.map((c) => c.name)} managers={managers}
                  isCollapsed={collapsed} onToggle={() => onToggle(block.name)} />
              );
            })}
            <tr className="border-t-2 border-white/10 bg-blue-500/[0.05]">
              <td className="px-4 py-2.5 font-bold text-white text-[12px] sticky left-0 bg-slate-900/90 backdrop-blur-sm z-10">Средний балл</td>
              {managers.map((m) => (
                <td key={m.id} className={`px-2 py-2.5 text-right font-mono text-[12px] font-bold ${getCriteriaColor(m.overallScore)} ${getCriteriaBg(m.overallScore)}`}>{fmtScore(m.overallScore)}</td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

function BlockManagerRows({ blockName, blockIdx, criteriaNames, managers, isCollapsed, onToggle }: {
  blockName: string; blockIdx: number; criteriaNames: string[]; managers: ManagerBreakdown[];
  isCollapsed: boolean; onToggle: () => void;
}) {
  // «Все» = строка-воронка без критериев → нечего раскрывать (см. BlockTimeRows).
  const hasChildren = criteriaNames.length > 0;
  return (
    <>
      <tr className={`bg-slate-900/60 border-t border-white/10 ${hasChildren ? "cursor-pointer hover:bg-slate-800/40" : ""}`} onClick={hasChildren ? onToggle : undefined}>
        <td className="px-4 py-2 sticky left-0 bg-slate-900/60 backdrop-blur-sm z-10">
          <div className="flex items-center gap-2">
            {hasChildren && (isCollapsed ? <ChevronDown className="w-3.5 h-3.5 text-slate-500" /> : <ChevronUp className="w-3.5 h-3.5 text-slate-500" />)}
            <span className="text-[11px] uppercase tracking-widest font-bold text-slate-300">{blockName}</span>
          </div>
        </td>
        {managers.map((m) => {
          const v = m.blocks[blockIdx]?.score;
          return <td key={m.id} className={`px-2 py-2 text-right font-mono text-[11px] font-bold ${getCriteriaColor(v)} ${getCriteriaBg(v)}`}>{fmtScore(v)}</td>;
        })}
      </tr>
      {hasChildren && !isCollapsed && criteriaNames.map((cName, ci) => (
        <tr key={`${blockName}-m-${cName}`} className="hover:bg-white/[0.02] border-b border-white/[0.03]">
          <td className="px-4 py-1.5 text-[11px] text-slate-400 sticky left-0 bg-slate-900/90 backdrop-blur-sm z-10 pl-10">{cName}</td>
          {managers.map((m) => {
            const v = m.blocks[blockIdx]?.criteria[ci]?.score;
            return <td key={m.id} className={`px-2 py-1.5 text-right font-mono text-[11px] ${getCriteriaColorFor(cName, v)} ${getCriteriaBgFor(cName, v)}`}>{fmtScoreFor(cName, v)}</td>;
          })}
        </tr>
      ))}
    </>
  );
}

// ==================== Line Tabs (B2B only) ====================
// Вкладки над таблицей в палитре дашборда (стекло/slate, без ярких цветов;
// нод к референсу Lea Verou «Slanted tabs» — едва заметный наклон-подложка).
// Активная сливается с таблицей: фон rgb(15,23,42) = фон шапки дерева, без
// нижней границы, текст blue-400 (синий акцент дашборда — тоггл источника,
// заголовок «Оценка»). Неактивные — приглушённый slate-800/40 + slate-400, как
// остальные контролы. Наклоняется только фон-подложка, текст остаётся прямым.
// Цвет подложки — через CSS-переменную --okk-tab-surface (тёмная/светлая тема
// задаются в globals.css), иначе inline-фон не переключался бы по теме.

// Мультивыбор менеджеров: дропдаун с чекбоксами. Пустой выбор = «Все менеджеры».
function ManagerMultiSelect({ managers, selected, onChange }: {
  managers: { id: string; name: string }[];
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const label =
    selected.length === 0 ? "Все менеджеры"
    : selected.length === 1 ? (managers.find((m) => m.id === selected[0])?.name ?? "1 выбран")
    : `${selected.length} менеджеров`;
  const toggle = (id: string) =>
    onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  return (
    <div className="relative">
      <button onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 bg-slate-800/50 border border-white/10 rounded-xl px-3 py-1.5 text-[11px] text-slate-300 hover:border-blue-500/40 focus:outline-none max-w-[190px]">
        <span className="truncate">{label}</span>
        <ChevronDown className="w-3 h-3 text-slate-500 shrink-0" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute z-50 mt-1 right-0 w-60 max-h-72 overflow-y-auto bg-slate-900 rounded-xl border border-white/10 p-1 shadow-2xl">
            <button onClick={() => onChange([])}
              className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg hover:bg-white/5 text-left">
              <span className={`text-[11px] ${selected.length === 0 ? "text-blue-300 font-semibold" : "text-slate-400"}`}>Все менеджеры</span>
            </button>
            {managers.map((m) => {
              const on = selected.includes(m.id);
              return (
                <button key={m.id} onClick={() => toggle(m.id)}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg hover:bg-white/5 text-left">
                  <span className={`w-3.5 h-3.5 rounded border flex items-center justify-center shrink-0 ${on ? "bg-blue-500 border-blue-500" : "border-white/20"}`}>
                    {on && <Check className="w-2.5 h-2.5 text-white" />}
                  </span>
                  <span className="truncate text-[11px] text-slate-300">{m.name}</span>
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

function LineTabs({ lines, active, onSelect }: {
  lines: { id: string; label: string }[];
  active: string;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="flex items-end gap-1 pl-2" style={{ marginBottom: -1 }}>
      {lines.map((l) => {
        const sel = l.id === active;
        return (
          <button
            key={l.id}
            type="button"
            onClick={() => onSelect(l.id)}
            className={`okk-line-tab relative px-5 pt-2 pb-2.5 text-[10px] uppercase tracking-widest font-bold transition-colors focus:outline-none ${
              sel ? "okk-line-tab-active text-blue-400" : "okk-line-tab-inactive text-slate-400 hover:text-white"
            }`}
          >
            <span
              aria-hidden
              className={`okk-line-tab-bg absolute inset-0 rounded-t-xl border-t border-x ${sel ? "border-white/10" : "border-white/5"}`}
              style={{
                background: sel ? "var(--okk-tab-surface)" : "var(--okk-tab-surface-inactive)",
                transform: "perspective(16px) rotateX(1.5deg)",
                transformOrigin: "bottom",
              }}
            />
            <span className="relative">{l.label}</span>
          </button>
        );
      })}
    </div>
  );
}

// ==================== Time Tree (B2B only) ====================
// Дерево слева: Неделя → Менеджер → Дата (раскрытие). Колонки: ОЦЕНКА + блоки →
// критерии (свёрнутый блок схлопывается в колонку-итог). Заменяет «Динамику по
// критериям» и «Разбивку по менеджерам» у Коммерсов; у Госников остаются
// прежние таблицы. Референс — выгрузка ОКК в Google Sheets. См. dev_docs/13 §8.

const TREE_HEADER_H = 30;
const TREE_HEADER_BG = "rgb(15, 23, 42)";

type TreeLeaf =
  | { kind: "overall" }
  | { kind: "block"; block: BlockData }
  | { kind: "crit"; block: BlockData; crit: CriterionScore };

// Ключ колонки в node.scores: имя блока (итог/воронка) или "блок::критерий".
// overall читается отдельно (node.overall), не из scores.
function leafColId(leaf: TreeLeaf): string {
  if (leaf.kind === "block") return leaf.block.name;
  if (leaf.kind === "crit") return `${leaf.block.name}::${leaf.crit.name}`;
  return "__overall__";
}

function CriteriaTimeTree({
  tree, blocks, department, source, spellitView, highlightedCallIds, collapsedBlocks, onToggleBlock, expandedWeeks, onToggleWeek, expandedMgrs, onToggleMgr, expandedDates, onToggleDate, canModerate, onExclude,
}: {
  tree: TimeTreeWeek[]; blocks: BlockData[];
  department: "b2g" | "b2b";
  source: "okk" | "roleplay";
  // Сервер инвертировал «Критические ошибки» (Spellit-вид) → красим их как «% плохого».
  spellitView: boolean;
  highlightedCallIds: Set<string>;
  collapsedBlocks: Set<string>; onToggleBlock: (n: string) => void;
  expandedWeeks: Set<string>; onToggleWeek: (k: string) => void;
  expandedMgrs: Set<string>; onToggleMgr: (k: string) => void;
  expandedDates: Set<string>; onToggleDate: (k: string) => void;
  // Moderation: exclude a call from the stats (admin/rop/teamlead only).
  canModerate: boolean;
  onExclude: (info: { callId: string; managerName: string; callDate: string; score: number | null }) => void;
}) {
  // Модалка «Аудио / Транскрипт» для звонка — открывается из меню строки в
  // нужном режиме; внутри можно переключаться.
  const [mediaModal, setMediaModal] = useState<{ callId: string; view: "audio" | "transcript" | "scores" } | null>(null);

  // Меню действий «⋯» у строки звонка (одна иконка вместо россыпи). Позиция
  // fixed по rect кнопки — таблица скроллится (overflow:auto), обычный
  // absolute-дропдаун обрезался бы контейнером.
  const [menu, setMenu] = useState<{ callId: string; kommoLeadUrl: string | null; managerName: string; callDate: string; score: number | null; x: number; y: number } | null>(null);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMenu(null); };
    // Скролл/ресайз уводят меню от кнопки — проще закрыть.
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);
  const isExpandedBlock = (b: BlockData) => b.criteria.length > 0 && !collapsedBlocks.has(b.name);
  // Вторая строка шапки нужна только если есть развёрнутый блок с критериями.
  const hasTwoRows = blocks.some(isExpandedBlock);

  // Кнопка «скопировать ссылку на сделку» у строки звонка — короткий ✓-фидбэк.
  const [copiedCallId, setCopiedCallId] = useState<string | null>(null);
  const copyLeadUrl = (callId: string, url: string) => {
    navigator.clipboard?.writeText(url).then(
      () => {
        setCopiedCallId(callId);
        setTimeout(() => setCopiedCallId((cur) => (cur === callId ? null : cur)), 1500);
      },
      () => { /* clipboard отклонён браузером — тихо игнорируем */ },
    );
  };

  // Плоский список колонок-листьев — тело таблицы итерирует его же.
  const leaves: TreeLeaf[] = [{ kind: "overall" }];
  for (const b of blocks) {
    if (isExpandedBlock(b)) for (const c of b.criteria) leaves.push({ kind: "crit", block: b, crit: c });
    else leaves.push({ kind: "block", block: b });
  }

  // Ряд ячеек-значений для одного узла дерева (неделя/менеджер/дата).
  const valueCells = (node: TimeTreeNode, strongAll: boolean) =>
    leaves.map((leaf, i) => {
      const v = leaf.kind === "overall" ? node.overall : node.scores[leafColId(leaf)];
      const strong = strongAll || leaf.kind !== "crit";
      // Критерии с особой семантикой (потеря клиента, talk ratio) красим
      // по имени; блоки и «ОЦЕНКА» — обычной шкалой.
      const critName = leaf.kind === "crit" ? leaf.crit.name : null;
      const color = critName ? getCriteriaColorFor(critName, v, spellitView) : getCriteriaColor(v);
      const bg = critName ? getCriteriaBgFor(critName, v, spellitView) : getCriteriaBg(v);
      return (
        <td key={i} className={`px-2 py-1.5 text-center font-mono text-[11px] ${strong ? "font-bold" : ""} ${color} ${bg}`}>
          {fmtScoreFor(critName, v)}
        </td>
      );
    });

  return (
    <>
    <div className="glass-panel text-slate-200 rounded-2xl border border-white/5 shadow-2xl">
      <div className="w-full rounded-2xl" style={{ overflowX: "auto", overflowY: "auto", maxHeight: "70vh" }}>
        <table className="text-left border-collapse">
          <thead className="z-40">
            {/* Строка 1 — метка дерева · ОЦЕНКА · заголовки блоков */}
            <tr className="light-panel-header border-b border-white/10">
              <th rowSpan={hasTwoRows ? 2 : 1}
                className="px-4 text-left text-[10px] uppercase tracking-widest text-slate-500 font-semibold sticky left-0 z-50 min-w-[210px]"
                style={{ backgroundColor: TREE_HEADER_BG, top: 0 }}>
                Неделя / Менеджер / Дата
              </th>
              <th rowSpan={hasTwoRows ? 2 : 1}
                className="px-2 text-center align-middle min-w-[56px] sticky z-40"
                style={{ backgroundColor: TREE_HEADER_BG, top: 0 }}>
                <div className="text-[9px] uppercase tracking-wider text-blue-300 font-bold">Оценка</div>
              </th>
              {blocks.map((b) => {
                const expanded = isExpandedBlock(b);
                const clickable = b.criteria.length > 0;
                if (expanded) {
                  return (
                    <th key={b.name} colSpan={b.criteria.length} onClick={() => onToggleBlock(b.name)}
                      className="px-2 text-center border-l border-white/10 sticky z-40 cursor-pointer hover:bg-white/5"
                      style={{ backgroundColor: TREE_HEADER_BG, top: 0, height: TREE_HEADER_H }}>
                      <div className="flex items-center justify-center gap-1">
                        <ChevronUp className="w-3 h-3 text-slate-500 shrink-0" />
                        <span className="text-[10px] uppercase tracking-wider text-slate-300 font-bold whitespace-nowrap">{b.name}</span>
                      </div>
                    </th>
                  );
                }
                return (
                  <th key={b.name} rowSpan={hasTwoRows ? 2 : 1} onClick={clickable ? () => onToggleBlock(b.name) : undefined}
                    className={`px-2 text-center border-l border-white/10 align-middle min-w-[60px] sticky z-40 ${clickable ? "cursor-pointer hover:bg-white/5" : ""}`}
                    style={{ backgroundColor: TREE_HEADER_BG, top: 0 }}>
                    {/* nowrap: заголовок блока в одну строку → высота строки-1
                        фиксирована, строка-2 (критерии) встаёт ровно по top:TREE_HEADER_H. */}
                    <div className="flex items-center justify-center gap-1">
                      {clickable && <ChevronDown className="w-3 h-3 text-slate-500 shrink-0" />}
                      <span className="text-[9px] uppercase tracking-wider text-slate-400 font-bold whitespace-nowrap">{b.name}</span>
                    </div>
                  </th>
                );
              })}
            </tr>
            {/* Строка 2 — заголовки критериев развёрнутых блоков */}
            {hasTwoRows && (
              <tr className="light-panel-header border-b border-white/10">
                {blocks.filter(isExpandedBlock).flatMap((b) =>
                  b.criteria.map((c, ci) => (
                    <th key={`${b.name}-${c.name}`}
                      className={`px-2 py-1 text-center align-bottom min-w-[58px] max-w-[82px] sticky z-30 ${ci === 0 ? "border-l border-white/10" : ""}`}
                      style={{ backgroundColor: TREE_HEADER_BG, top: TREE_HEADER_H }}>
                      <div className="text-[9px] text-slate-400 font-medium leading-tight whitespace-normal break-words">{c.displayName ?? c.name}</div>
                    </th>
                  )),
                )}
              </tr>
            )}
          </thead>
          <tbody className="text-sm">
            {tree.map((week) => {
              const wkOpen = expandedWeeks.has(week.key);
              return (
                <Fragment key={week.key}>
                  {/* Неделя */}
                  <tr className="bg-slate-900/60 border-t border-white/10 cursor-pointer hover:bg-slate-800/40" onClick={() => onToggleWeek(week.key)}>
                    <td className="px-3 py-2 sticky left-0 bg-slate-900/70 backdrop-blur-sm z-10">
                      <div className="flex items-center gap-1.5">
                        {wkOpen ? <ChevronUp className="w-3.5 h-3.5 text-slate-500 shrink-0" /> : <ChevronDown className="w-3.5 h-3.5 text-slate-500 shrink-0" />}
                        <span className="text-[11px] font-bold text-slate-200 whitespace-nowrap">{week.label}</span>
                        <span className="text-[10px] text-slate-500">· {week.callCount} зв.</span>
                      </div>
                    </td>
                    {valueCells(week, true)}
                  </tr>
                  {/* Менеджеры недели */}
                  {wkOpen && week.managers.map((mgr) => {
                    const mgrKey = `${week.key}::${mgr.id}`;
                    const mgrOpen = expandedMgrs.has(mgrKey);
                    return (
                      <Fragment key={mgrKey}>
                        <tr className="border-t border-white/[0.04] cursor-pointer hover:bg-white/[0.03]" onClick={() => onToggleMgr(mgrKey)}>
                          <td className="px-3 py-1.5 sticky left-0 bg-slate-900/80 backdrop-blur-sm z-10">
                            <div className="flex items-center gap-1.5 pl-5">
                              {mgrOpen ? <ChevronUp className="w-3 h-3 text-slate-600 shrink-0" /> : <ChevronDown className="w-3 h-3 text-slate-600 shrink-0" />}
                              <span className="text-[11px] font-semibold text-slate-300 whitespace-nowrap">{mgr.name}</span>
                              <span className="text-[10px] text-slate-600">· {mgr.callCount}</span>
                            </div>
                          </td>
                          {valueCells(mgr, false)}
                        </tr>
                        {/* Даты менеджера — раскрываются в отдельные звонки (4-й уровень) */}
                        {mgrOpen && mgr.dates.map((d) => {
                          const dateKey = `${mgrKey}::${d.date}`;
                          const hasCalls = d.calls.length > 0;
                          const dateOpen = hasCalls && expandedDates.has(dateKey);
                          return (
                            <Fragment key={dateKey}>
                              <tr
                                className={`border-b border-white/[0.03] hover:bg-white/[0.02] ${hasCalls ? "cursor-pointer" : ""}`}
                                onClick={hasCalls ? () => onToggleDate(dateKey) : undefined}
                              >
                                <td className="px-3 py-1 sticky left-0 bg-slate-900/90 backdrop-blur-sm z-10">
                                  <span className="flex items-center gap-1 pl-11 text-[10px] text-slate-500 whitespace-nowrap">
                                    {hasCalls
                                      ? (dateOpen ? <ChevronUp className="w-3 h-3 text-slate-600 shrink-0" /> : <ChevronDown className="w-3 h-3 text-slate-600 shrink-0" />)
                                      : <span className="w-3 shrink-0" />}
                                    {d.date} · {d.callCount} зв.
                                  </span>
                                </td>
                                {valueCells(d, false)}
                              </tr>
                              {/* Звонки/сделки дня */}
                              {dateOpen && d.calls.map((c) => {
                                const isHi = highlightedCallIds.has(c.callId);
                                return (
                                <tr key={c.callId} id={`okk-call-${c.callId}`} className={`border-b border-white/[0.02] ${isHi ? "okk-row-hl" : "bg-slate-950/40 hover:bg-white/[0.02]"}`}>
                                  <td className={`px-3 py-1 sticky left-0 backdrop-blur-sm z-10 bg-slate-950/60`}>
                                    <span className="flex items-center gap-1.5 pl-[68px] text-[10px] text-slate-400 whitespace-nowrap">
                                      {/* Действия по звонку — одно меню «⋯» */}
                                      <button
                                        type="button"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          const r = e.currentTarget.getBoundingClientRect();
                                          const MENU_W = 320, MENU_H = 280, GAP = 4;
                                          // По умолчанию под кнопкой; если не влезает вниз — открываем вверх.
                                          let y = r.bottom + GAP;
                                          if (y + MENU_H > window.innerHeight - 8) y = Math.max(8, r.top - MENU_H - GAP);
                                          // Не вылезать за правый край.
                                          let x = r.left;
                                          if (x + MENU_W > window.innerWidth - 8) x = Math.max(8, window.innerWidth - MENU_W - 8);
                                          setMenu({ callId: c.callId, kommoLeadUrl: c.kommoLeadUrl, managerName: mgr.name, callDate: d.date, score: c.overall, x, y });
                                        }}
                                        className="text-slate-500 hover:text-white shrink-0"
                                        title="Действия"
                                      >
                                        <MoreHorizontal className="w-3.5 h-3.5" />
                                      </button>
                                      {c.direction === "inbound" ? (
                                        <PhoneIncoming className="w-3 h-3 text-emerald-500/70 shrink-0" />
                                      ) : c.direction === "outbound" ? (
                                        <PhoneOutgoing className="w-3 h-3 text-sky-500/70 shrink-0" />
                                      ) : null}
                                      <span className="flex items-center gap-0.5 tabular-nums" title="Время начала звонка">
                                        <Clock className="w-3 h-3 text-slate-600 shrink-0" />
                                        {fmtBerlinTime(c.startedAt) || "—"}
                                      </span>
                                      {c.durationSec != null && (
                                        <span className="flex items-center gap-0.5 tabular-nums text-slate-600" title="Продолжительность звонка (мин:сек)">
                                          <Timer className="w-3 h-3 shrink-0" />
                                          {fmtDuration(c.durationSec)}
                                        </span>
                                      )}
                                      {/* Полная ссылка Kommo — обрезана визуально, но полный текст
                                          в DOM, чтобы нативный Ctrl+F нашёл сделку по ссылке. */}
                                      {c.kommoLeadUrl && (
                                        <a
                                          href={c.kommoLeadUrl}
                                          target="_blank"
                                          rel="noopener noreferrer"
                                          onClick={(e) => e.stopPropagation()}
                                          className="min-w-0 max-w-[150px] truncate text-[9px] text-blue-400/50 hover:text-blue-300"
                                          title={c.kommoLeadUrl}
                                        >
                                          {c.kommoLeadUrl}
                                        </a>
                                      )}
                                    </span>
                                  </td>
                                  {valueCells(c, true)}
                                </tr>
                                );
                              })}
                            </Fragment>
                          );
                        })}
                      </Fragment>
                    );
                  })}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
    {/* Меню действий по звонку */}
    {menu && (
      <>
        <div className="fixed inset-0 z-40" onClick={() => setMenu(null)} />
        <div
          className="fixed z-50 w-[320px] bg-slate-900 rounded-xl border border-white/15 py-1 shadow-2xl shadow-black/50 text-[12px]"
          style={{ left: menu.x, top: menu.y }}
        >
          {menu.kommoLeadUrl && (
            <a
              href={menu.kommoLeadUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => setMenu(null)}
              className="flex items-center gap-2 px-3 py-2 text-slate-300 hover:bg-white/5"
            >
              <ExternalLink className="w-3.5 h-3.5 text-blue-400 shrink-0" /> Открыть в Kommo
            </a>
          )}
          {menu.kommoLeadUrl && (
            <div className="px-3 py-2 border-y border-white/5">
              <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">Ссылка на сделку</div>
              <div className="flex items-center gap-1.5">
                <input
                  readOnly
                  value={menu.kommoLeadUrl}
                  onClick={(e) => e.currentTarget.select()}
                  className="flex-1 min-w-0 bg-slate-800/60 border border-white/10 rounded px-2 py-1 text-[11px] text-slate-300 focus:outline-none focus:border-blue-500/40"
                />
                <button
                  type="button"
                  onClick={() => copyLeadUrl(menu.callId, menu.kommoLeadUrl!)}
                  className="shrink-0 flex items-center gap-1 px-2 py-1 rounded bg-blue-500/80 hover:bg-blue-500 text-white text-[11px] font-semibold"
                  title="Копировать ссылку"
                >
                  {copiedCallId === menu.callId
                    ? <Check className="w-3.5 h-3.5" />
                    : <Copy className="w-3.5 h-3.5" />}
                  {copiedCallId === menu.callId ? "Скоп." : "Копир."}
                </button>
              </div>
            </div>
          )}
          <button
            type="button"
            onClick={() => { setMediaModal({ callId: menu.callId, view: "audio" }); setMenu(null); }}
            className="w-full flex items-center gap-2 px-3 py-2 text-slate-300 hover:bg-white/5"
          >
            <Play className="w-3.5 h-3.5 text-emerald-400 shrink-0" /> Прослушать
          </button>
          <button
            type="button"
            onClick={() => { setMediaModal({ callId: menu.callId, view: "transcript" }); setMenu(null); }}
            className="w-full flex items-center gap-2 px-3 py-2 text-slate-300 hover:bg-white/5"
          >
            <FileText className="w-3.5 h-3.5 text-blue-400 shrink-0" /> Транскрипт
          </button>
          <button
            type="button"
            onClick={() => { setMediaModal({ callId: menu.callId, view: "scores" }); setMenu(null); }}
            className="w-full flex items-center gap-2 px-3 py-2 text-slate-300 hover:bg-white/5"
          >
            <ListChecks className="w-3.5 h-3.5 text-purple-400 shrink-0" /> Детализация оценок
          </button>
          {canModerate && (
            <button
              type="button"
              onClick={() => {
                onExclude({ callId: menu.callId, managerName: menu.managerName, callDate: menu.callDate, score: menu.score });
                setMenu(null);
              }}
              className="w-full flex items-center gap-2 px-3 py-2 text-rose-300 hover:bg-rose-500/10 border-t border-white/5"
              title="Убрать этот звонок из всех средних оценок"
            >
              <Ban className="w-3.5 h-3.5 text-rose-400 shrink-0" /> Исключить из статистики
            </button>
          )}
        </div>
      </>
    )}
    {mediaModal && (
      <CallMediaModal
        callId={mediaModal.callId}
        dept={department}
        source={source}
        initialView={mediaModal.view}
        onClose={() => setMediaModal(null)}
      />
    )}
    </>
  );
}

// ==================== Call media modal (audio + transcript) ====================

interface EvalDetailCriterion {
  name: string; score: number | null; maxScore: number;
  feedback: string; quote: string; applicable?: boolean;
  // Секунда в записи звонка, где прозвучала цитата критерия (null — нет цитаты
  // или не удалось сматчить). Рендерим как MM:SS.
  atSecond?: number | null;
}
interface EvalDetailBlock {
  name: string; score: number; maxScore: number; criteria: EvalDetailCriterion[];
}
interface CallMeta {
  clientName: string | null; phone: string | null; source: string | null;
  leadCategory: string | null; stageAtCallStart: string | null; stageAtPickup: string | null;
  week: string | null; callDateTime: string | null; analyzedAt: string | null;
}
// Реплика чат-транскрипта: спикер + текст + секунда старта (для таймкода MM:SS).
interface TranscriptTurn {
  speaker: "manager" | "client"; text: string; atSecond: number | null;
}

function CallMediaModal({ callId, dept, source, initialView, onClose }: {
  callId: string;
  dept: "b2g" | "b2b";
  source: "okk" | "roleplay";
  initialView: "audio" | "transcript" | "scores";
  onClose: () => void;
}) {
  const [view, setView] = useState<"audio" | "transcript" | "scores">(initialView);
  const [data, setData] = useState<{
    name: string; date: string; callDuration: string;
    transcript: string; audioUrl: string; hasRecording: boolean;
    kommoUrl?: string; score?: number; totalMaxScore?: number; totalRawScore?: number;
    blocks?: EvalDetailBlock[]; meta?: CallMeta; transcriptTurns?: TranscriptTurn[];
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Свежий монтаж при каждом открытии → loading=true/error=null уже выставлены
    // начальным useState; здесь только асинхронный фетч (без sync setState в эффекте).
    let cancelled = false;
    // Ролевки живут в R1/D1 (эндпоинт `/api/calls/[id]?department=`), реальные
    // звонки ОКК — в R2/D2 (`/api/okk/calls/[id]?dept=`). Обе ручки возвращают
    // совместимую форму для модалки (name/date/callDuration/transcript/
    // audioUrl/hasRecording).
    const url = source === "roleplay"
      ? `/api/calls/${callId}?department=${dept}`
      : `/api/okk/calls/${callId}?dept=${dept}`;
    fetch(url)
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        if (j.success) setData(j.data);
        else setError(j.error || "Не удалось загрузить звонок");
      })
      .catch(() => { if (!cancelled) setError("Ошибка загрузки"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [callId, dept, source]);

  // Esc закрывает модалку.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // pl-56 ≈ ширина сайдбара (w-48 + gap): центрируем окно в информационной
  // части вкладки (справа от навигации), а не по всему вьюпорту.
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 sm:pl-56" onClick={onClose}>
      <div
        className={`glass-panel rounded-2xl border border-white/10 w-full ${view === "scores" ? "max-w-6xl" : "max-w-2xl"} max-h-[85vh] flex flex-col`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Шапка */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-white/5">
          <div className="min-w-0">
            <div className="text-sm font-bold text-slate-200 truncate">{data?.name || "Звонок"}</div>
            {data && <div className="text-[11px] text-slate-500">{data.date} · {data.callDuration}</div>}
          </div>
          <div className="flex items-center gap-3 shrink-0">
            {typeof data?.score === "number" && (data.blocks?.length ?? 0) > 0 && (
              <span
                className={`px-2.5 py-1 rounded-lg text-sm font-black ${
                  data.score >= 66
                    ? "bg-emerald-500/15 text-emerald-400"
                    : data.score >= 41
                    ? "bg-amber-500/15 text-amber-400"
                    : "bg-rose-500/15 text-rose-400"
                }`}
                title="Общая оценка звонка"
              >
                {data.score}%
              </span>
            )}
            <button onClick={onClose} className="p-1.5 rounded-lg text-slate-500 hover:text-white hover:bg-white/5" title="Закрыть">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Переключатель Аудио / Транскрипт */}
        <div className="flex gap-1 px-5 pt-3">
          <button
            onClick={() => setView("audio")}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-bold uppercase tracking-wider transition-all ${view === "audio" ? "bg-emerald-500/20 text-emerald-400" : "text-slate-500 hover:text-slate-300"}`}
          >
            <Play className="w-3.5 h-3.5" /> Аудио
          </button>
          <button
            onClick={() => setView("transcript")}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-bold uppercase tracking-wider transition-all ${view === "transcript" ? "bg-blue-500/20 text-blue-400" : "text-slate-500 hover:text-slate-300"}`}
          >
            <FileText className="w-3.5 h-3.5" /> Транскрипт
          </button>
          <button
            onClick={() => setView("scores")}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-bold uppercase tracking-wider transition-all ${view === "scores" ? "bg-purple-500/20 text-purple-400" : "text-slate-500 hover:text-slate-300"}`}
          >
            <ListChecks className="w-3.5 h-3.5" /> Оценки
          </button>
        </div>

        {/* Тело */}
        <div className="p-5 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-10 text-slate-500"><Loader2 className="w-5 h-5 animate-spin" /></div>
          ) : error ? (
            <div className="py-10 text-center text-rose-400 text-sm">{error}</div>
          ) : view === "scores" ? (
            data?.blocks?.length ? (
              <EvalDetailView blocks={data.blocks} meta={data.meta} kommoUrl={data.kommoUrl} duration={data.callDuration} manager={data.name} score={data.score} totalMaxScore={data.totalMaxScore} totalRawScore={data.totalRawScore} />
            ) : (
              <div className="py-10 text-center text-slate-500 text-sm">Детализация оценки недоступна для этого звонка</div>
            )
          ) : view === "audio" ? (
            data?.hasRecording ? (
              <audio controls preload="none" src={data.audioUrl} className="w-full">
                Ваш браузер не поддерживает аудио.
              </audio>
            ) : (
              <div className="py-10 text-center text-slate-500 text-sm">Запись недоступна</div>
            )
          ) : (
            data?.transcript || data?.transcriptTurns?.length ? (
              <TranscriptView transcript={data.transcript} turns={data.transcriptTurns} />
            ) : (
              <div className="py-10 text-center text-slate-500 text-sm">Транскрипт недоступен</div>
            )
          )}
        </div>
      </div>
    </div>
  );
}

// «Детализация оценок» — Spellit-вид: шапка с метаданными звонка + широкая
// горизонтально-прокручиваемая таблица, где КАЖДЫЙ критерий = колонка
// (двухрядная шапка: блок → критерий с номером/баллом; тело — Причина +
// Цитата с таймкодом MM:SS). Состав
// полей — по спеке dev_docs/Книга1.xlsx (серые колонки; красные исключены).
// Причина/цитата заполнены у оценок criteria-engine (~с мая 2026); у legacy
// звонков поля пустые — рендерим только то, что есть.
// Пороги цвета оценки (66/41) — единые для бейджа в шапке и блоков.
// [Auto-override…]-маркеры движка срезаются на стороне API (см.
// api/okk/calls/[callId]/route.ts stripEngineTags) — здесь feedback уже чистый.
function scoreTone(pct: number): string {
  return pct >= 66 ? "text-emerald-400" : pct >= 41 ? "text-amber-400" : "text-rose-400";
}

// Секунды → MM:SS для таймкода критерия в записи звонка.
function fmtMmSs(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

// Бейдж вердикта критерия (✓1 / ✗0 / N/M / Пусто / Инфо / —). Вынесен, чтобы
// шапка-колонка горизонтальной детализации и любые списки критериев красили
// балл одинаково.
function CriterionBadge({ c }: { c: EvalDetailCriterion }) {
  const isEmpty = c.applicable === false;
  const isInfo = !isEmpty && c.maxScore === 0;
  // null (нераспознанный вердикт, okk) и -1 (то же у ролевок) — «не оценён».
  const isUnscored = !isEmpty && !isInfo && (c.score == null || c.score < 0);
  const passed = !isEmpty && !isInfo && !isUnscored && (c.score ?? 0) >= c.maxScore;
  const base = "shrink-0 px-1.5 py-0.5 rounded text-[10px] font-bold";
  if (isEmpty) return <span className={`${base} uppercase tracking-wider bg-slate-700/40 text-slate-400`}>Пусто</span>;
  if (isUnscored) return <span className={`${base} bg-slate-700/40 text-slate-400`} title="Вердикт не распознан">—</span>;
  if (isInfo) return <span className={`${base} uppercase tracking-wider bg-blue-500/15 text-blue-400`}>Инфо</span>;
  if (c.maxScore > 1) return <span className={`${base} bg-purple-500/15 text-purple-300`}>{c.score}/{c.maxScore}</span>;
  if (passed) return <span className={`${base} bg-emerald-500/15 text-emerald-400`}>✓ 1</span>;
  return <span className={`${base} bg-rose-500/15 text-rose-400`}>✗ 0</span>;
}

function EvalDetailView({ blocks, meta, kommoUrl, duration, manager, score, totalMaxScore, totalRawScore }: {
  blocks: EvalDetailBlock[];
  meta?: CallMeta;
  kommoUrl?: string;
  duration: string;
  manager: string;
  score?: number;
  totalMaxScore?: number;
  totalRawScore?: number;
}) {
  const metaRows: Array<[string, string | null | undefined]> = [
    [
      "Общая оценка",
      typeof score === "number"
        ? `${score}%${totalMaxScore != null && totalRawScore != null ? ` (${totalRawScore}/${totalMaxScore} баллов)` : ""}`
        : null,
    ],
    ["Дата звонка", meta?.callDateTime],
    ["Неделя звонка", meta?.week],
    ["Длительность", duration],
    ["Менеджер", manager],
    ["Клиент", meta?.clientName],
    ["Телефон", meta?.phone],
    ["Источник", meta?.source],
    ["Категория лида", meta?.leadCategory],
    ["Этап в начале звонка", meta?.stageAtCallStart],
    ["Этап при заборе звонка", meta?.stageAtPickup],
    ["Дата анализа", meta?.analyzedAt],
  ];

  // В горизонтальную таблицу берём только блоки с критериями: legacy
  // feedback-only блоки (criteria=[]) дали бы лишнюю ячейку-шапку без колонки
  // под ней и сломали бы выравнивание colSpan.
  const tableBlocks = blocks.filter((b) => b.criteria.length > 0);

  // Сквозная нумерация критериев 1..N через все блоки — как id в конфиге
  // критериев (src/criteria/*.json) и в Spellit-таблице. offset[bi] = сколько
  // критериев в предыдущих блоках; номер критерия = offset + ci + 1.
  const blockOffsets = tableBlocks.reduce<number[]>((acc, _b, i) => {
    acc.push(i === 0 ? 0 : acc[i - 1] + tableBlocks[i - 1].criteria.length);
    return acc;
  }, []);

  // Метаданные звонка — колонки справа (каждое поле = своя колонка, как
  // критерии). Kommo-ссылка идёт последним столбцом.
  const metaItems: Array<{ label: string; node: React.ReactNode }> = metaRows
    .filter(([, v]) => v)
    .map(([label, value]) => ({ label, node: value as React.ReactNode }));
  if (kommoUrl && kommoUrl !== "#") {
    metaItems.push({
      label: "Сделка",
      node: (
        <a href={kommoUrl} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300 inline-flex items-center gap-1 break-all">
          <ExternalLink className="w-3 h-3 shrink-0" /> Открыть в Kommo
        </a>
      ),
    });
  }

  return (
    <div className="flex flex-col">
      {/* Горизонтальная детализация: критерии — колонки (как в Spellit-таблице).
          Метаданные звонка — отдельная колонка «Данные звонка» справа. Скролл
          только по горизонтали: высота ячеек ограничена, вертикали нет. Шапка в
          два ряда: блок (colSpan над критериями) + критерий (номер/название/балл).
          Тело — одна строка: Причина + Цитата с MM:SS. */}
      {tableBlocks.length === 0 ? (
        <div className="py-10 text-center text-slate-500 text-sm">Нет критериев для отображения</div>
      ) : (
      <div className="overflow-x-auto rounded-xl border border-white/5 scrollbar-thin scrollbar-thumb-slate-700 scrollbar-track-transparent">
        <table className="border-separate border-spacing-0 text-left">
          <thead>
            {/* Ряд 1 — метаданные (слева) + блоки (этапы) */}
            <tr>
              {/* Данные звонка — компактный блок слева (как бывшая верхняя
                  шапка: сетка подпись/значение в 2 колонки, а не длинный
                  вертикальный список — иначе съедает высоту) */}
              {metaItems.length > 0 && (
                <th
                  rowSpan={2}
                  className="sticky top-0 z-20 align-top p-3 border-b border-white/10 bg-slate-900/95 backdrop-blur-sm min-w-[420px] max-w-[460px] w-[440px]"
                >
                  <span className="text-[11px] font-bold uppercase tracking-wider text-slate-300 whitespace-nowrap">Данные звонка</span>
                </th>
              )}
              {tableBlocks.map((b, bi) => {
                const pct = b.maxScore > 0 ? Math.round((b.score / b.maxScore) * 100) : null;
                return (
                  <th
                    key={`blk-${bi}-${b.name}`}
                    colSpan={Math.max(1, b.criteria.length)}
                    className={`sticky top-0 z-20 h-9 px-3 border-b border-white/10 bg-slate-900/95 backdrop-blur-sm text-left ${bi === 0 ? "border-l-2 border-l-white/20" : "border-l border-l-white/10"}`}
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] font-bold uppercase tracking-wider text-slate-300 whitespace-nowrap">{b.name}</span>
                      {pct != null && (
                        <span className="text-[10px] font-bold text-slate-400 whitespace-nowrap">
                          {b.score}/{b.maxScore} · <span className={scoreTone(pct)}>{pct}%</span>
                        </span>
                      )}
                    </div>
                  </th>
                );
              })}
            </tr>
            {/* Ряд 2 — критерии (колонка метаданных занята rowSpan из ряда 1) */}
            <tr>
              {tableBlocks.flatMap((b, bi) =>
                b.criteria.map((c, ci) => (
                  <th
                    key={`crit-${bi}-${ci}-${c.name}`}
                    style={{ top: 36 }}
                    className={`sticky z-10 align-top p-2.5 border-b border-white/10 bg-slate-900/95 backdrop-blur-sm min-w-[260px] max-w-[300px] w-[280px] ${bi === 0 && ci === 0 ? "border-l-2 border-l-white/20" : "border-l border-l-white/10"}`}
                  >
                    <div className="flex items-start gap-2">
                      <CriterionBadge c={c} />
                      <span className="text-[12px] font-semibold text-slate-200 leading-snug whitespace-normal break-words">
                        <span className="text-slate-500 tabular-nums">{blockOffsets[bi] + ci + 1}.</span> {c.name}
                      </span>
                    </div>
                  </th>
                )),
              )}
            </tr>
          </thead>
          <tbody>
            {/* Одна строка данных = один звонок */}
            <tr>
              {/* Данные звонка — компактная сетка 2×N (подпись + значение) */}
              {metaItems.length > 0 && (
                <td className="align-top p-3 min-w-[420px] max-w-[460px] w-[440px]">
                  <div className="max-h-[52vh] overflow-y-auto pr-1 grid grid-cols-2 gap-x-4 gap-y-2.5">
                    {metaItems.map((m) => (
                      <div key={m.label} className="min-w-0">
                        <div className="text-[10px] uppercase tracking-wider text-slate-500">{m.label}</div>
                        <div className="text-[12px] text-slate-200 break-words">{m.node}</div>
                      </div>
                    ))}
                  </div>
                </td>
              )}
              {tableBlocks.flatMap((b, bi) =>
                b.criteria.map((c, ci) => (
                  <td
                    key={`cell-${bi}-${ci}-${c.name}`}
                    className={`align-top p-2.5 min-w-[260px] max-w-[300px] w-[280px] ${bi === 0 && ci === 0 ? "border-l-2 border-l-white/20" : "border-l border-white/5"}`}
                  >
                    <div className="max-h-[52vh] overflow-y-auto pr-1 flex flex-col gap-2">
                      {c.feedback ? (
                        <div>
                          <div className="text-[9px] uppercase tracking-wider text-slate-500 mb-0.5">Причина</div>
                          <p className="text-[12px] text-slate-400 leading-relaxed whitespace-pre-wrap break-words">{c.feedback}</p>
                        </div>
                      ) : null}
                      {c.quote ? (
                        <div>
                          <div className="flex items-center gap-1.5 mb-0.5">
                            <span className="text-[9px] uppercase tracking-wider text-slate-500">Цитата</span>
                            {c.atSecond != null && (
                              <span
                                className="inline-flex items-center gap-0.5 text-[10px] font-mono tabular-nums text-slate-500"
                                title="Момент в записи звонка, где прозвучала цитата"
                              >
                                <Clock className="w-3 h-3" /> {fmtMmSs(c.atSecond)}
                              </span>
                            )}
                          </div>
                          <blockquote className="text-[11px] text-slate-500 leading-relaxed border-l-2 border-slate-600 pl-2.5 whitespace-pre-wrap break-words">
                            {c.quote}
                          </blockquote>
                        </div>
                      ) : null}
                      {!c.feedback && !c.quote && (
                        <span className="text-[11px] text-slate-600 italic">—</span>
                      )}
                    </div>
                  </td>
                )),
              )}
            </tr>
          </tbody>
        </table>
      </div>
      )}
    </div>
  );
}

// Чат-вид транскрипта (пузыри Продавец/Клиент), как в модалке ОКК Госников
// (src/app/page.tsx, «Детальная Расшифровка»). Понимает оба формата меток:
// `[Продавец]:`/`[Клиент]:` (ОКК R2/D2, buildSpeakerTranscript) и
// `Менеджер:`/`Клиент:` (ролевки R1/D1). Если меток нет вовсе (сырой
// транскрипт без диаризации) — падаем обратно на сплошной текст, чтобы не
// красить весь разговор «Клиентом».
function TranscriptView({ transcript, turns }: { transcript: string; turns?: TranscriptTurn[] }) {
  // Источник реплик: структурированные turns (со спикером и таймкодом) —
  // приоритетно; иначе парсим строковый транскрипт (легаси, без таймкодов).
  const { rows, hasLabels } = useMemo(() => {
    if (turns && turns.length) {
      return {
        rows: turns.map((t) => ({
          isManager: t.speaker === "manager",
          text: t.text,
          atSecond: t.atSecond,
        })),
        hasLabels: true,
      };
    }
    const lines = transcript.split("\n").filter((l) => l.trim());
    const labelled = lines.some(
      (l) => l.includes("[Продавец]") || l.includes("[Клиент]") || /^(Менеджер|Клиент):/.test(l),
    );
    // Строка без метки — продолжение предыдущей реплики (utterance с \n
    // внутри), а не новая реплика «Клиента»: наследует спикера и клеится
    // к текущему ходу.
    const acc: Array<{ isManager: boolean; text: string; atSecond: number | null }> = [];
    for (const line of lines) {
      const hasLabel =
        line.includes("[Продавец]") || line.includes("[Клиент]") || /^(Менеджер|Клиент):/.test(line);
      const isManager = line.includes("[Продавец]") || line.startsWith("Менеджер:");
      const clean = line
        .replace(/^\[Продавец\]:\s*/, "")
        .replace(/^\[Клиент\]:\s*/, "")
        .replace(/^(Менеджер:|Клиент:)\s*/, "");
      if (!clean.trim()) continue;
      const last = acc[acc.length - 1];
      if (!hasLabel && last) last.text += `\n${clean}`;
      else acc.push({ isManager: hasLabel ? isManager : false, text: clean, atSecond: null });
    }
    return { rows: acc, hasLabels: labelled };
  }, [transcript, turns]);

  if (!hasLabels) {
    // Сырой транскрипт без диаризации — жирный тёмный текст (transcript-plain
    // перекрашивается в светлой теме, см. globals.css).
    return (
      <div className="transcript-plain text-[12px] font-semibold text-slate-200 leading-relaxed whitespace-pre-wrap max-h-[55vh] overflow-y-auto">
        {transcript}
      </div>
    );
  }

  return (
    <div className="text-[12px] leading-relaxed max-h-[55vh] overflow-y-auto flex flex-col gap-3 pr-2 scrollbar-thin scrollbar-thumb-slate-700 scrollbar-track-slate-900/50">
      {rows.map((t, idx) => (
        <div key={idx} className={`flex ${t.isManager ? "justify-end" : "justify-start"} w-full`}>
          <div className={`flex flex-col gap-1 ${t.isManager ? "items-end" : "items-start"} max-w-[75%]`}>
            <span className={`text-[10px] uppercase tracking-wider font-bold px-2 flex items-center gap-1.5 ${t.isManager ? "text-blue-400" : "text-emerald-400"}`}>
              {t.isManager ? "Продавец" : "Клиент"}
              {t.atSecond != null && (
                <span className="inline-flex items-center gap-0.5 font-mono normal-case tracking-normal text-slate-500">
                  <Clock className="w-3 h-3" /> {fmtMmSs(t.atSecond)}
                </span>
              )}
            </span>
            {/* transcript-bubble-* перекрашиваются в светлой теме (globals.css):
                тёмный текст на читаемой заливке. font-semibold — жирный текст. */}
            <div className={`p-3 rounded-2xl whitespace-pre-wrap font-semibold ${t.isManager
              ? "transcript-bubble-manager bg-blue-500/15 text-slate-100 rounded-tr-none border border-blue-500/30 shadow-sm"
              : "transcript-bubble-client bg-emerald-500/10 text-slate-100 rounded-tl-none border border-emerald-500/20 shadow-sm"
            }`}>
              {t.text}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ==================== Comparison: Criteria Table ====================

interface AggregatedBlock {
  name: string;
  score: number | null;
  criteria: Array<{ name: string; score: number | null }>;
}

function aggregateData(data: AnalyticsData): { blocks: AggregatedBlock[]; overall: number | null } {
  const blocks: AggregatedBlock[] = data.blocks.map((b) => ({
    name: b.name,
    score: avgScores(b.scores),
    criteria: b.criteria.map((c) => ({
      name: c.name,
      score: avgScores(c.scores),
    })),
  }));
  const overall = avgScores(data.overallScores);
  return { blocks, overall };
}

function ComparisonCriteriaTable({ dataA, dataB, labelA, labelB, collapsedBlocks, onToggle, spellitView }: {
  dataA: AnalyticsData; dataB: AnalyticsData;
  labelA: string; labelB: string;
  collapsedBlocks: Set<string>; onToggle: (n: string) => void;
  spellitView: boolean;
}) {
  const aggA = aggregateData(dataA);
  const aggB = aggregateData(dataB);

  // Merge block names preserving order
  const blockNames: string[] = [];
  for (const b of aggA.blocks) { if (!blockNames.includes(b.name)) blockNames.push(b.name); }
  for (const b of aggB.blocks) { if (!blockNames.includes(b.name)) blockNames.push(b.name); }

  return (
    <div className="glass-panel text-slate-200 rounded-2xl border border-white/5 shadow-2xl">
      <div className="w-full rounded-2xl" style={{ overflowX: "auto", overflowY: "auto", maxHeight: "70vh" }}>
        <table className="w-full text-left border-collapse">
          <thead className="sticky top-0 z-40" style={{ backgroundColor: "rgb(15, 23, 42)", boxShadow: "0 2px 8px rgba(0,0,0,0.4)" }}>
            <tr className="light-panel-header border-b border-white/10">
              <th className="px-4 py-2.5 text-[10px] uppercase tracking-widest text-slate-500 font-semibold sticky left-0 z-50 min-w-[260px]" style={{ backgroundColor: "rgb(15, 23, 42)" }}>
                Критерий
              </th>
              <th className="px-3 py-2.5 text-center min-w-[100px]">
                <div className="text-[9px] uppercase tracking-wider text-blue-400 font-bold">{labelA}</div>
                <div className="text-[10px] text-white font-bold">{dataA.totalCalls} зв.</div>
              </th>
              <th className="px-3 py-2.5 text-center min-w-[100px]">
                <div className="text-[9px] uppercase tracking-wider text-orange-400 font-bold">{labelB}</div>
                <div className="text-[10px] text-white font-bold">{dataB.totalCalls} зв.</div>
              </th>
              <th className="px-3 py-2.5 text-center min-w-[60px]">
                <div className="text-[9px] uppercase tracking-wider text-slate-500 font-bold">Δ</div>
              </th>
            </tr>
          </thead>
          <tbody className="text-sm">
            {blockNames.map((blockName) => {
              const blockA = aggA.blocks.find((b) => b.name === blockName);
              const blockB = aggB.blocks.find((b) => b.name === blockName);
              const collapsed = collapsedBlocks.has(blockName);

              const criteriaNames: string[] = [];
              for (const c of blockA?.criteria ?? []) { if (!criteriaNames.includes(c.name)) criteriaNames.push(c.name); }
              for (const c of blockB?.criteria ?? []) { if (!criteriaNames.includes(c.name)) criteriaNames.push(c.name); }

              const scoreA = blockA?.score ?? null;
              const scoreB = blockB?.score ?? null;

              return (
                <CompareBlockRows key={blockName} blockName={blockName} scoreA={scoreA} scoreB={scoreB}
                  blockA={blockA} blockB={blockB} criteriaNames={criteriaNames}
                  isCollapsed={collapsed} onToggle={() => onToggle(blockName)} spellitView={spellitView} />
              );
            })}
            <tr className="border-t-2 border-white/10 bg-blue-500/[0.05]">
              <td className="px-4 py-2.5 font-bold text-white text-[12px] sticky left-0 bg-slate-900/90 backdrop-blur-sm z-10">Средний балл</td>
              <td className={`px-3 py-2.5 text-center font-mono text-[12px] font-bold ${getCriteriaColor(aggA.overall)} ${getCriteriaBg(aggA.overall)}`}>{fmtScore(aggA.overall)}</td>
              <td className={`px-3 py-2.5 text-center font-mono text-[12px] font-bold ${getCriteriaColor(aggB.overall)} ${getCriteriaBg(aggB.overall)}`}>{fmtScore(aggB.overall)}</td>
              <td className={`px-3 py-2.5 text-center font-mono text-[12px] font-bold ${getDeltaColor(aggA.overall, aggB.overall)}`}>{fmtDelta(aggA.overall, aggB.overall)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CompareBlockRows({ blockName, scoreA, scoreB, blockA, blockB, criteriaNames, isCollapsed, onToggle, spellitView }: {
  blockName: string; scoreA: number | null; scoreB: number | null;
  blockA?: AggregatedBlock; blockB?: AggregatedBlock; criteriaNames: string[];
  isCollapsed: boolean; onToggle: () => void; spellitView: boolean;
}) {
  // «Все» = строка-воронка без критериев → нечего раскрывать (см. BlockTimeRows).
  const hasChildren = criteriaNames.length > 0;
  return (
    <>
      <tr className={`bg-slate-900/60 border-t border-white/10 ${hasChildren ? "cursor-pointer hover:bg-slate-800/40" : ""}`} onClick={hasChildren ? onToggle : undefined}>
        <td className="px-4 py-2 sticky left-0 bg-slate-900/60 backdrop-blur-sm z-10">
          <div className="flex items-center gap-2">
            {hasChildren && (isCollapsed ? <ChevronDown className="w-3.5 h-3.5 text-slate-500" /> : <ChevronUp className="w-3.5 h-3.5 text-slate-500" />)}
            <span className="text-[11px] uppercase tracking-widest font-bold text-slate-300">{blockName}</span>
          </div>
        </td>
        <td className={`px-3 py-2 text-center font-mono text-[11px] font-bold ${getCriteriaColor(scoreA)} ${getCriteriaBg(scoreA)}`}>{fmtScore(scoreA)}</td>
        <td className={`px-3 py-2 text-center font-mono text-[11px] font-bold ${getCriteriaColor(scoreB)} ${getCriteriaBg(scoreB)}`}>{fmtScore(scoreB)}</td>
        <td className={`px-3 py-2 text-center font-mono text-[11px] font-bold ${getDeltaColor(scoreA, scoreB)}`}>{fmtDelta(scoreA, scoreB)}</td>
      </tr>
      {hasChildren && !isCollapsed && criteriaNames.map((cName) => {
        const cA = blockA?.criteria.find((c) => c.name === cName)?.score ?? null;
        const cB = blockB?.criteria.find((c) => c.name === cName)?.score ?? null;
        // У инвертированных критериев рост = хуже → дельту красим наоборот;
        // у нейтральных дельта без оценочного цвета.
        const deltaColor = NEUTRAL_CRITERIA.has(cName)
          ? "text-slate-400"
          : isInvertedFor(cName, spellitView)
            ? getDeltaColor(cB, cA)
            : getDeltaColor(cA, cB);
        return (
          <tr key={`${blockName}-cmp-${cName}`} className="hover:bg-white/[0.02] border-b border-white/[0.03]">
            <td className="px-4 py-1.5 text-[11px] text-slate-400 sticky left-0 bg-slate-900/90 backdrop-blur-sm z-10 pl-10">{cName}</td>
            <td className={`px-3 py-1.5 text-center font-mono text-[11px] ${getCriteriaColorFor(cName, cA, spellitView)} ${getCriteriaBgFor(cName, cA, spellitView)}`}>{fmtScoreFor(cName, cA)}</td>
            <td className={`px-3 py-1.5 text-center font-mono text-[11px] ${getCriteriaColorFor(cName, cB, spellitView)} ${getCriteriaBgFor(cName, cB, spellitView)}`}>{fmtScoreFor(cName, cB)}</td>
            <td className={`px-3 py-1.5 text-center font-mono text-[11px] ${deltaColor}`}>{fmtDelta(cA, cB)}</td>
          </tr>
        );
      })}
    </>
  );
}

// ==================== Comparison: Managers Table ====================

function ComparisonManagerTable({ dataA, dataB, labelA, labelB, collapsedBlocks, onToggle }: {
  dataA: AnalyticsData; dataB: AnalyticsData;
  labelA: string; labelB: string;
  collapsedBlocks: Set<string>; onToggle: (n: string) => void;
}) {
  // Merge managers from both periods
  const allIds = new Set([
    ...dataA.managerBreakdown.map((m) => m.id),
    ...dataB.managerBreakdown.map((m) => m.id),
  ]);

  const merged = [...allIds].map((id) => {
    const a = dataA.managerBreakdown.find((m) => m.id === id);
    const b = dataB.managerBreakdown.find((m) => m.id === id);
    return { id, name: a?.name ?? b?.name ?? "—", a, b };
  }).sort((x, y) => {
    const avgX = ((x.a?.overallScore ?? 0) + (x.b?.overallScore ?? 0)) / 2;
    const avgY = ((y.a?.overallScore ?? 0) + (y.b?.overallScore ?? 0)) / 2;
    return avgY - avgX;
  });

  // Merge block names
  const blockNames: string[] = [];
  for (const b of dataA.blocks) { if (!blockNames.includes(b.name)) blockNames.push(b.name); }
  for (const b of dataB.blocks) { if (!blockNames.includes(b.name)) blockNames.push(b.name); }

  return (
    <div className="glass-panel text-slate-200 rounded-2xl border border-white/5 shadow-2xl">
      <div className="w-full rounded-2xl" style={{ overflowX: "auto", overflowY: "auto", maxHeight: "70vh" }}>
        <table className="w-full text-left border-collapse">
          <thead className="sticky top-0 z-40" style={{ backgroundColor: "rgb(15, 23, 42)", boxShadow: "0 2px 8px rgba(0,0,0,0.4)" }}>
            <tr className="light-panel-header border-b border-white/10">
              <th className="px-4 py-2.5 text-[10px] uppercase tracking-widest text-slate-500 font-semibold sticky left-0 z-50 min-w-[180px]" style={{ backgroundColor: "rgb(15, 23, 42)" }}>
                Менеджер
              </th>
              <th className="px-2 py-2.5 text-center min-w-[50px]">
                <div className="text-[9px] uppercase tracking-wider text-blue-400 font-bold">Зв.</div>
              </th>
              <th className="px-3 py-2.5 text-center min-w-[80px]">
                <div className="text-[9px] uppercase tracking-wider text-blue-400 font-bold">{labelA}</div>
              </th>
              <th className="px-2 py-2.5 text-center min-w-[50px]">
                <div className="text-[9px] uppercase tracking-wider text-orange-400 font-bold">Зв.</div>
              </th>
              <th className="px-3 py-2.5 text-center min-w-[80px]">
                <div className="text-[9px] uppercase tracking-wider text-orange-400 font-bold">{labelB}</div>
              </th>
              <th className="px-3 py-2.5 text-center min-w-[60px]">
                <div className="text-[9px] uppercase tracking-wider text-slate-500 font-bold">Δ</div>
              </th>
            </tr>
          </thead>
          <tbody className="text-sm">
            {merged.map((m) => {
              const collapsed = collapsedBlocks.has(m.id);
              return (
                <CompareManagerRows key={m.id} mgr={m} blockNames={blockNames}
                  isCollapsed={collapsed} onToggle={() => onToggle(m.id)} />
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CompareManagerRows({ mgr, blockNames, isCollapsed, onToggle }: {
  mgr: { id: string; name: string; a?: ManagerBreakdown; b?: ManagerBreakdown };
  blockNames: string[];
  isCollapsed: boolean; onToggle: () => void;
}) {
  const scoreA = mgr.a?.overallScore ?? null;
  const scoreB = mgr.b?.overallScore ?? null;

  return (
    <>
      <tr className="border-t border-white/10 cursor-pointer hover:bg-slate-800/40" onClick={onToggle}>
        <td className="px-4 py-2 sticky left-0 bg-slate-900/80 backdrop-blur-sm z-10">
          <div className="flex items-center gap-2">
            {isCollapsed ? <ChevronDown className="w-3 h-3 text-slate-500" /> : <ChevronUp className="w-3 h-3 text-slate-500" />}
            <span className="text-[11px] font-bold text-white">{mgr.name}</span>
          </div>
        </td>
        <td className="px-2 py-2 text-center text-[11px] text-white font-bold">{mgr.a?.callCount ?? 0}</td>
        <td className={`px-3 py-2 text-center font-mono text-[12px] font-bold ${getCriteriaColor(scoreA)} ${getCriteriaBg(scoreA)}`}>{fmtScore(scoreA)}</td>
        <td className="px-2 py-2 text-center text-[11px] text-white font-bold">{mgr.b?.callCount ?? 0}</td>
        <td className={`px-3 py-2 text-center font-mono text-[12px] font-bold ${getCriteriaColor(scoreB)} ${getCriteriaBg(scoreB)}`}>{fmtScore(scoreB)}</td>
        <td className={`px-3 py-2 text-center font-mono text-[12px] font-bold ${getDeltaColor(scoreA, scoreB)}`}>{fmtDelta(scoreA, scoreB)}</td>
      </tr>
      {!isCollapsed && blockNames.map((bName) => {
        // Look up by name, not positional index — when dataA and dataB
        // have different block sets (e.g. after a criteria edit) the
        // positional access returns the wrong row's score for the union
        // entries, silently corrupting the delta column.
        const bScoreA = mgr.a?.blocks.find((b) => b.name === bName)?.score ?? null;
        const bScoreB = mgr.b?.blocks.find((b) => b.name === bName)?.score ?? null;
        return (
          <tr key={`${mgr.id}-${bName}`} className="hover:bg-white/[0.02] border-b border-white/[0.03]">
            <td className="px-4 py-1.5 text-[10px] text-slate-500 sticky left-0 bg-slate-900/90 backdrop-blur-sm z-10 pl-10">{bName}</td>
            <td />
            <td className={`px-3 py-1.5 text-center font-mono text-[10px] ${getCriteriaColor(bScoreA)} ${getCriteriaBg(bScoreA)}`}>{fmtScore(bScoreA)}</td>
            <td />
            <td className={`px-3 py-1.5 text-center font-mono text-[10px] ${getCriteriaColor(bScoreB)} ${getCriteriaBg(bScoreB)}`}>{fmtScore(bScoreB)}</td>
            <td className={`px-3 py-1.5 text-center font-mono text-[10px] ${getDeltaColor(bScoreA, bScoreB)}`}>{fmtDelta(bScoreA, bScoreB)}</td>
          </tr>
        );
      })}
    </>
  );
}
