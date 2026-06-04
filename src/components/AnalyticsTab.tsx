"use client";

import { useState, useEffect, useCallback, useRef, useMemo, Fragment } from "react";
import { RefreshCw, Loader2, ChevronDown, ChevronUp, ArrowLeftRight } from "lucide-react";
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

interface CriterionScore { name: string; scores: Record<string, number> }
interface BlockData { name: string; scores: Record<string, number>; criteria: CriterionScore[] }
interface ManagerCriterion { name: string; score: number | null }
interface ManagerBlock { name: string; score: number | null; criteria: ManagerCriterion[] }
interface ManagerBreakdown { id: string; name: string; overallScore: number | null; callCount: number; blocks: ManagerBlock[] }
// B2B-only: дерево «неделя → менеджер → дата». overall = средний % за звонок;
// scores — баллы по колонкам (ключ = имя блока ИЛИ "блок::критерий").
interface TimeTreeNode { callCount: number; overall: number | null; scores: Record<string, number> }
interface TimeTreeDate extends TimeTreeNode { date: string }
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

function getAnalyticsLines(dept: "b2g" | "b2b"): { id: string; label: string }[] {
  return getLines(dept).map((l) => ({ id: l.id, label: l.shortLabel ?? l.label }));
}

// Скрытые направления верхней сводки B2B (мультивыбор) — сохраняются между
// сессиями. Храним массив id скрытых линий.
const HIDDEN_DIRECTIONS_KEY = "sm_analytics_b2b_hidden_directions";

// ==================== Main Component ====================

export default function AnalyticsTab({ department }: { department: "b2g" | "b2b" }) {
  const [source, setSource] = useState<"okk" | "roleplay">("okk");
  // Коммерсы: вид по вкладкам линий без «Все» → стартуем на первой линии.
  // Госники: кросс-воронка «Все» + опциональный per-line drill-down.
  const [line, setLine] = useState<string>(() => (department === "b2b" ? getLines("b2b")[0]?.id ?? "all" : "all"));
  const [groupBy, setGroupBy] = useState<"day" | "week" | "month">("day");
  const [managerId, setManagerId] = useState("");
  const [dateRange, setDateRange] = useState<DateRange>(() => {
    // Berlin-civil 30-day window. Browser-local `setDate(now − 30)` produced
    // a Date whose `fmtDate` (now Berlin) read as one day off the picker
    // highlight in non-Berlin browsers.
    const end = todayBerlinDate();
    const start = berlinCivilDate(addDaysCivil(todayCivil(), -30));
    return { start, end };
  });

  const [data, setData] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [collapsedBlocks, setCollapsedBlocks] = useState<Set<string>>(new Set());
  const [collapsedMgrBlocks, setCollapsedMgrBlocks] = useState<Set<string>>(new Set());
  // B2B-дерево: раскрытые недели (ключ = week.key) и менеджеры (ключ = "week::mgrId").
  const [expandedWeeks, setExpandedWeeks] = useState<Set<string>>(new Set());
  const [expandedMgrs, setExpandedMgrs] = useState<Set<string>>(new Set());
  // B2B OKK: верхняя сводка «Динамика по критериям» — все линии (воронки) × даты.
  // Отдельный fetch line="all", не зависит от выбранной вкладки линии.
  const [overview, setOverview] = useState<AnalyticsData | null>(null);
  // Скрытые направления в сводке (мультивыбор). Храним id скрытых линий; читаем
  // из localStorage в эффекте (а не в инициализаторе) — гидрация цела.
  const [hiddenDirections, setHiddenDirections] = useState<Set<string>>(new Set());

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
    setManagerId("");
  }, [department]);
  useEffect(() => {
    setManagerId("");
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
      const current = getLines(department).find((l) => l.id === line);
      if (current && current.id !== current.group) setLine(current.group);
    }
  }, [source, line, department]);
  // If selected manager is not in current list, clear selection
  useEffect(() => {
    if (managerId && data?.managers && !data.managers.some((m) => m.id === managerId)) {
      setManagerId("");
    }
  }, [data?.managers, managerId]);

  const buildParams = useCallback((range: DateRange) => {
    const fromStr = range.start ? fmtDate(range.start) : "";
    const toStr = range.end ? fmtDate(range.end) : "";
    if (!fromStr || !toStr) return null;
    // Roleplay calls aren't tagged with the B2G sub-line, so collapse both
    // 2a/2b → "2" before hitting the API. The collapse effect also runs but
    // is async; doing it here too eliminates the race-window.
    const effectiveLine = source === "roleplay" && (line === "2a" || line === "2b") ? "2" : line;
    const params = new URLSearchParams({ department, source, line: effectiveLine, groupBy, from: fromStr, to: toStr });
    if (managerId) params.set("managerId", managerId);
    return params;
  }, [department, source, line, groupBy, managerId]);

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
    if (managerId) params.set("managerId", managerId);
    try {
      const res = await fetch(`/api/analytics?${params}`, { signal });
      if (!res.ok) throw new Error(`API error ${res.status}`);
      const json = await res.json();
      if (json.success) setOverview(json.data);
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
    }
  }, [department, source, compareMode, dateRange, managerId]);

  useEffect(() => {
    const ac = new AbortController();
    fetchData(ac.signal);
    return () => ac.abort();
  }, [fetchData]);

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

  const setQuickRange = (days: number) => {
    const end = todayBerlinDate();
    const start = berlinCivilDate(addDaysCivil(todayCivil(), -days));
    setDateRange({ start, end });
  };

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
            <button onClick={() => { setLine("all"); setManagerId(""); }}
              className={`px-2.5 py-1.5 rounded-lg text-[10px] uppercase tracking-widest font-bold transition-all ${
                line === "all" ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30" : "text-slate-400 hover:text-white"
              }`}>
              Все
            </button>
            {(() => {
              const lines = getAnalyticsLines(department);
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
              <button key={l.id} onClick={() => { setLine(l.id); setManagerId(""); }}
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
          onClear={() => setQuickRange(30)}
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
          <select value={managerId} onChange={(e) => setManagerId(e.target.value)}
            className="bg-slate-800/50 border border-white/10 rounded-xl px-3 py-1.5 text-[11px] text-slate-300 focus:outline-none focus:border-blue-500/40 max-w-[170px]">
            <option value="">Все менеджеры</option>
            {data.managers.map((m) => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
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
          />

          {!managerId && (data.managerBreakdown.length > 0 || compareData.managerBreakdown.length > 0) && (
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
            {source === "okk" && (
              <LineTabs lines={getAnalyticsLines(department)} active={line} onSelect={setLine} />
            )}
            {data && data.timeTree.length > 0 ? (
              <CriteriaTimeTree
                tree={data.timeTree}
                blocks={data.blocks}
                collapsedBlocks={collapsedMgrBlocks}
                onToggleBlock={(n) => toggle(setCollapsedMgrBlocks, n)}
                expandedWeeks={expandedWeeks}
                onToggleWeek={(k) => toggle(setExpandedWeeks, k)}
                expandedMgrs={expandedMgrs}
                onToggleMgr={(k) => toggle(setExpandedMgrs, k)}
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
          {data && data.managerBreakdown.length > 0 && !managerId && (
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
  blocks, periods, groupBy, overallScores, collapsedBlocks, onToggle,
}: {
  blocks: BlockData[]; periods: string[]; groupBy: string;
  overallScores: Record<string, number>;
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
            <tr className="border-t-2 border-white/10 bg-blue-500/[0.05]">
              <td className="px-4 py-2.5 font-bold text-white text-[12px] sticky left-0 bg-slate-900/90 backdrop-blur-sm z-10">Средний балл</td>
              {periods.map((p) => {
                const v = overallScores[p];
                return <td key={p} className={`px-2 py-2.5 text-right font-mono text-[12px] font-bold ${getCriteriaColor(v)} ${getCriteriaBg(v)}`}>{fmtScore(v)}</td>;
              })}
            </tr>
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
            return <td key={p} className={`px-2 py-1.5 text-right font-mono text-[11px] ${getCriteriaColor(v)} ${getCriteriaBg(v)}`}>{fmtScore(v)}</td>;
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
            return <td key={m.id} className={`px-2 py-1.5 text-right font-mono text-[11px] ${getCriteriaColor(v)} ${getCriteriaBg(v)}`}>{fmtScore(v)}</td>;
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

const TAB_SURFACE = "rgb(15, 23, 42)"; // = фон шапки дерева → бесшовный стык

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
            className={`relative px-5 pt-2 pb-2.5 text-[10px] uppercase tracking-widest font-bold transition-colors focus:outline-none ${
              sel ? "text-blue-400" : "text-slate-400 hover:text-white"
            }`}
          >
            <span
              aria-hidden
              className={`absolute inset-0 rounded-t-xl border-t border-x ${sel ? "border-white/10" : "border-white/5"}`}
              style={{
                background: sel ? TAB_SURFACE : "rgba(30, 41, 59, 0.4)",
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
  tree, blocks, collapsedBlocks, onToggleBlock, expandedWeeks, onToggleWeek, expandedMgrs, onToggleMgr,
}: {
  tree: TimeTreeWeek[]; blocks: BlockData[];
  collapsedBlocks: Set<string>; onToggleBlock: (n: string) => void;
  expandedWeeks: Set<string>; onToggleWeek: (k: string) => void;
  expandedMgrs: Set<string>; onToggleMgr: (k: string) => void;
}) {
  const isExpandedBlock = (b: BlockData) => b.criteria.length > 0 && !collapsedBlocks.has(b.name);
  // Вторая строка шапки нужна только если есть развёрнутый блок с критериями.
  const hasTwoRows = blocks.some(isExpandedBlock);

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
      return (
        <td key={i} className={`px-2 py-1.5 text-center font-mono text-[11px] ${strong ? "font-bold" : ""} ${getCriteriaColor(v)} ${getCriteriaBg(v)}`}>
          {fmtScore(v)}
        </td>
      );
    });

  return (
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
                      <div className="text-[9px] text-slate-400 font-medium leading-tight whitespace-normal break-words">{c.name}</div>
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
                        {/* Даты менеджера */}
                        {mgrOpen && mgr.dates.map((d) => (
                          <tr key={`${mgrKey}::${d.date}`} className="border-b border-white/[0.03] hover:bg-white/[0.02]">
                            <td className="px-3 py-1 sticky left-0 bg-slate-900/90 backdrop-blur-sm z-10">
                              <span className="block pl-11 text-[10px] text-slate-500 whitespace-nowrap">{d.date} · {d.callCount} зв.</span>
                            </td>
                            {valueCells(d, false)}
                          </tr>
                        ))}
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

function ComparisonCriteriaTable({ dataA, dataB, labelA, labelB, collapsedBlocks, onToggle }: {
  dataA: AnalyticsData; dataB: AnalyticsData;
  labelA: string; labelB: string;
  collapsedBlocks: Set<string>; onToggle: (n: string) => void;
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
                  isCollapsed={collapsed} onToggle={() => onToggle(blockName)} />
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

function CompareBlockRows({ blockName, scoreA, scoreB, blockA, blockB, criteriaNames, isCollapsed, onToggle }: {
  blockName: string; scoreA: number | null; scoreB: number | null;
  blockA?: AggregatedBlock; blockB?: AggregatedBlock; criteriaNames: string[];
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
        <td className={`px-3 py-2 text-center font-mono text-[11px] font-bold ${getCriteriaColor(scoreA)} ${getCriteriaBg(scoreA)}`}>{fmtScore(scoreA)}</td>
        <td className={`px-3 py-2 text-center font-mono text-[11px] font-bold ${getCriteriaColor(scoreB)} ${getCriteriaBg(scoreB)}`}>{fmtScore(scoreB)}</td>
        <td className={`px-3 py-2 text-center font-mono text-[11px] font-bold ${getDeltaColor(scoreA, scoreB)}`}>{fmtDelta(scoreA, scoreB)}</td>
      </tr>
      {hasChildren && !isCollapsed && criteriaNames.map((cName) => {
        const cA = blockA?.criteria.find((c) => c.name === cName)?.score ?? null;
        const cB = blockB?.criteria.find((c) => c.name === cName)?.score ?? null;
        return (
          <tr key={`${blockName}-cmp-${cName}`} className="hover:bg-white/[0.02] border-b border-white/[0.03]">
            <td className="px-4 py-1.5 text-[11px] text-slate-400 sticky left-0 bg-slate-900/90 backdrop-blur-sm z-10 pl-10">{cName}</td>
            <td className={`px-3 py-1.5 text-center font-mono text-[11px] ${getCriteriaColor(cA)} ${getCriteriaBg(cA)}`}>{fmtScore(cA)}</td>
            <td className={`px-3 py-1.5 text-center font-mono text-[11px] ${getCriteriaColor(cB)} ${getCriteriaBg(cB)}`}>{fmtScore(cB)}</td>
            <td className={`px-3 py-1.5 text-center font-mono text-[11px] ${getDeltaColor(cA, cB)}`}>{fmtDelta(cA, cB)}</td>
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
