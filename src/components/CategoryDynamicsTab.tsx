"use client";

// Вкладка «Динамика категорий» (b2b, admin-only).
//
// Макет повторяет рабочий excel «Конверсия по категориям», в котором время
// идёт ПО КОЛОНКАМ, а метрики — по строкам: динамика категории читается слева
// направо, как график. Колонки — подпериоды выбранного окна (год → месяцы,
// месяц → недели, неделя → дни; всегда ≤13 колонок — вся картина одним
// взглядом) + «Итого». Строки — секции метрик как в excel: Доля лидов (по
// категориям, с микро-баром цвета категории), Продажи, Конверсия от общего,
// Конверсия категории (свёрнута по умолчанию). Drill-down — клик по заголовку
// колонки (зум в подпериод) с хлебной крошкой назад.
//
// Цвета категорий — валидированная категориальная палитра (dataviz-skill,
// dark surface #0f172a): A…E — фиксированные слоты, «Без метки» — нейтральный
// серый (отсутствие категории, а не серия). Текст всегда в text-токенах,
// цвет несут только марки (точки и микро-бары).
//
// «Правильное количество лидов» и «продажа» определены на сервере
// (src/lib/category-dynamics/data.ts) — сверено 1в1 с выгрузками Kommo за
// июнь (459/27) и март (500/24).

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ChevronLeft, ChevronRight, Loader2, Undo2 } from "lucide-react";
import CalendarPicker from "@/components/CalendarPicker";
import DinoLoader from "@/components/DinoLoader";
import {
  fmtLocalDate as formatDate,
  todayBerlinDate,
  berlinCivilDate,
  addDaysCivil,
  diffDaysCivil,
  todayCivil,
} from "@/lib/utils/date";

// ==================== Types ====================

const CATEGORY_KEYS = ["A", "B", "C", "D", "E", ""] as const;
type CategoryKey = (typeof CATEGORY_KEYS)[number];

interface DayRow {
  date: string;
  category: CategoryKey;
  leads: number;
  sales: number;
}

interface ApiResponse {
  success?: boolean;
  error?: string;
  days: DayRow[];
}

type Funnel = "buh" | "med" | "all";

const FUNNEL_LABEL: Record<Funnel, string> = {
  buh: "Бух Комм",
  med: "Мед Комм",
  all: "Обе воронки",
};

// Категориальная палитра (валидирована validate_palette.js, dark #0f172a).
// «Без метки» — нейтральный серый: отсутствие категории, не серия.
const CAT_COLOR: Record<CategoryKey, string> = {
  A: "#3987e5",
  B: "#199e70",
  C: "#c98500",
  D: "#008300",
  E: "#9085e9",
  "": "#64748b",
};

const CAT_LABEL: Record<CategoryKey, string> = {
  A: "A", B: "B", C: "C", D: "D", E: "E", "": "Без метки",
};

// ==================== Aggregation ====================

interface CatAgg {
  leads: number;
  sales: number;
}

interface RangeAgg {
  byCat: Record<CategoryKey, CatAgg>;
  totalLeads: number;
  totalSales: number;
}

type DayMap = Map<string, Partial<Record<CategoryKey, CatAgg>>>;

function buildDayMap(days: DayRow[]): DayMap {
  const map: DayMap = new Map();
  for (const r of days) {
    let byCat = map.get(r.date);
    if (!byCat) { byCat = {}; map.set(r.date, byCat); }
    const agg = byCat[r.category] ?? { leads: 0, sales: 0 };
    agg.leads += r.leads;
    agg.sales += r.sales;
    byCat[r.category] = agg;
  }
  return map;
}

function emptyByCat(): Record<CategoryKey, CatAgg> {
  return Object.fromEntries(
    CATEGORY_KEYS.map((k) => [k, { leads: 0, sales: 0 }]),
  ) as Record<CategoryKey, CatAgg>;
}

/** Суммирует дневные агрегаты по civil-диапазону [from, to]. */
function aggregateRange(dayMap: DayMap, from: string, to: string): RangeAgg {
  const byCat = emptyByCat();
  let totalLeads = 0;
  let totalSales = 0;
  for (let d = from; d <= to; d = addDaysCivil(d, 1)) {
    const day = dayMap.get(d);
    if (!day) continue;
    for (const k of CATEGORY_KEYS) {
      const v = day[k];
      if (!v) continue;
      byCat[k].leads += v.leads;
      byCat[k].sales += v.sales;
      totalLeads += v.leads;
      totalSales += v.sales;
    }
  }
  return { byCat, totalLeads, totalSales };
}

// 0=Пн … 6=Вс (civil-дата, TZ не участвует).
function dowMonday(dateStr: string): number {
  const d = new Date(`${dateStr}T00:00:00Z`).getUTCDay();
  return (d + 6) % 7;
}

const MONTH_NAMES = [
  "Январь", "Февраль", "Март", "Апрель", "Май", "Июнь",
  "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь",
];
// Родительный падеж — для дат вида «16 июня».
const MONTH_GEN = [
  "января", "февраля", "марта", "апреля", "мая", "июня",
  "июля", "августа", "сентября", "октября", "ноября", "декабря",
];
const WEEKDAY_SHORT = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

/** «16 июня» из civil-даты. */
function fmtDayGen(s: string): string {
  return `${Number(s.slice(8, 10))} ${MONTH_GEN[Number(s.slice(5, 7)) - 1]}`;
}

const fmtDM = (s: string) => `${s.slice(8, 10)}.${s.slice(5, 7)}`;

type Unit = "year" | "month" | "week" | "day";

/** Гранулярность колонок: ≤8 дней — дни; ≤62 — недели; ≤366 — месяцы; иначе годы. */
function unitForSpan(spanDays: number): Unit {
  if (spanDays <= 8) return "day";
  if (spanDays <= 62) return "week";
  if (spanDays <= 366) return "month";
  return "year";
}

/** Кусочки диапазона [from,to] для юнита: календарные границы, клипнутые диапазоном. */
function sliceRange(from: string, to: string, unit: Unit): Array<{ from: string; to: string }> {
  const out: Array<{ from: string; to: string }> = [];
  let cur = from;
  let guard = 0;
  while (cur <= to && guard < 1000) {
    guard++;
    let end: string;
    if (unit === "day") {
      end = cur;
    } else if (unit === "week") {
      end = addDaysCivil(cur, 6 - dowMonday(cur)); // до воскресенья
    } else if (unit === "month") {
      const [y, m] = [Number(cur.slice(0, 4)), Number(cur.slice(5, 7))];
      const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
      end = `${cur.slice(0, 7)}-${String(lastDay).padStart(2, "0")}`;
    } else {
      end = `${cur.slice(0, 4)}-12-31`;
    }
    if (end > to) end = to;
    out.push({ from: cur, to: end });
    cur = addDaysCivil(end, 1);
  }
  return out;
}

/** Подпись группы-периода: развёрнутые даты («Июнь 2026», «16–22 июня»,
 *  «30 июня – 6 июля», «Пн, 16 июня»). */
function columnLabel(unit: Unit, from: string, to: string): string {
  if (unit === "day") return `${WEEKDAY_SHORT[dowMonday(from)]}, ${fmtDayGen(from)}`;
  if (unit === "week") {
    // Неделя внутри одного месяца — «16–22 июня»; через границу — «30 июня – 6 июля».
    return from.slice(0, 7) === to.slice(0, 7)
      ? `${Number(from.slice(8, 10))}–${fmtDayGen(to)}`
      : `${fmtDayGen(from)} – ${fmtDayGen(to)}`;
  }
  if (unit === "month") return `${MONTH_NAMES[Number(from.slice(5, 7)) - 1]} ${from.slice(0, 4)}`;
  return `${from.slice(0, 4)} год`;
}

// ==================== Formatting ====================

/** Проценты как в excel: ≥10 — целые; <10 — один знак («1.7%»), нули без хвоста. */
function fmtPct(num: number, den: number): string {
  if (den <= 0) return "—";
  const pct = (num / den) * 100;
  if (pct === 0) return "0%";
  if (pct >= 10) return `${Math.round(pct)}%`;
  const one = Math.round(pct * 10) / 10;
  return `${Number.isInteger(one) ? one.toFixed(0) : one.toFixed(1)}%`;
}

/** Тултип ячейки категории: все числа за раз. */
function cellTitle(catLabel: string, cat: CatAgg, totalLeads: number): string {
  return [
    `${catLabel}: ${cat.leads} лидов (${fmtPct(cat.leads, totalLeads)} от общего)`,
    `Продажи: ${cat.sales}`,
    `Конверсия категории: ${fmtPct(cat.sales, cat.leads)}`,
    `Конверсия от общего: ${fmtPct(cat.sales, totalLeads)}`,
  ].join("\n");
}

// ==================== Small pieces ====================

/** Точка-марка категории рядом с текстом (текст всегда в text-токенах). */
function CatDot({ k }: { k: CategoryKey }) {
  return <span className="inline-block w-2 h-2 rounded-full shrink-0" style={{ background: CAT_COLOR[k] }} />;
}

/** KPI-плитка: label · value · delta к сравнительному периоду. */
function StatTile({ label, value, sub, delta, deltaLabel }: {
  label: string;
  value: string;
  sub?: string;
  delta?: { text: string; good: boolean } | null;
  deltaLabel?: string;
}) {
  return (
    <div className="glass-panel rounded-2xl p-4 border border-white/5 min-w-0">
      <p className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">{label}</p>
      <div className="flex items-baseline gap-2 flex-wrap">
        <span className="text-2xl font-semibold text-white">{value}</span>
        {sub && <span className="text-xs text-slate-400">{sub}</span>}
      </div>
      {delta && (
        <p className="text-[11px] mt-1">
          <span className={delta.good ? "text-emerald-400" : "text-rose-400"}>{delta.text}</span>
          {deltaLabel && <span className="text-slate-500"> {deltaLabel}</span>}
        </p>
      )}
    </div>
  );
}

/** Дельта количества: «+12%» к базе. null, когда базы нет. */
function pctDelta(cur: number, ref: number): { text: string; good: boolean } | null {
  if (ref <= 0) return null;
  const pct = Math.round(((cur - ref) / ref) * 100);
  return { text: `${pct >= 0 ? "+" : ""}${pct}%`, good: pct >= 0 };
}

/** Дельта конверсии в процентных пунктах. */
function ppDelta(curNum: number, curDen: number, refNum: number, refDen: number): { text: string; good: boolean } | null {
  if (curDen <= 0 || refDen <= 0) return null;
  const pp = (curNum / curDen - refNum / refDen) * 100;
  const rounded = Math.round(pp * 10) / 10;
  return { text: `${rounded >= 0 ? "+" : ""}${rounded} п.п.`, good: rounded >= 0 };
}

// ==================== Excel-калька: группы колонок = периоды, внутри — категории ====================

// Строки метрик — 1в1 порядок excel «Конверсия по категориям». Строка
// «Всего лидов» сюда не входит: она merged на всю группу (одно число на
// период) и рендерится отдельной строкой перед этим списком.
type MetricRowId = "leads" | "share" | "sales" | "convTotal" | "convCat";

const METRIC_ROWS: Array<{ id: MetricRowId; label: string }> = [
  { id: "leads", label: "Лиды категории" },
  { id: "share", label: "% от общего" },
  { id: "sales", label: "Продажи" },
  { id: "convTotal", label: "Конверсия от общего" },
  { id: "convCat", label: "Конверсия категории" },
];

function metricCell(id: MetricRowId, k: CategoryKey, agg: RangeAgg): string {
  const v = agg.byCat[k];
  if (agg.totalLeads === 0) return "—";
  switch (id) {
    case "leads": return String(v.leads);
    case "share": return fmtPct(v.leads, agg.totalLeads);
    case "sales": return String(v.sales);
    case "convTotal": return fmtPct(v.sales, agg.totalLeads);
    case "convCat": return fmtPct(v.sales, v.leads);
  }
}

function metricMuted(id: MetricRowId, k: CategoryKey, agg: RangeAgg): boolean {
  const v = agg.byCat[k];
  if (agg.totalLeads === 0) return true;
  if (id === "leads" || id === "share") return v.leads === 0;
  return v.sales === 0;
}

// Липкая колонка подписей поверх горизонтального скролла: фон должен быть
// непрозрачным (glass-panel полупрозрачный — сквозь него видно проехавшие
// ячейки) и ИМЕНОВАННЫМ классом: светлая тема (.theme-light в globals.css)
// перекрашивает только именованные Tailwind-классы, произвольный bg-[#hex]
// остался бы тёмной полосой на светлом фоне.
const STICKY_CELL = "sticky left-0 z-10 bg-slate-900";

function GroupsTable({ title, days, from, to, onZoom }: {
  title: string;
  days: DayRow[];
  from: string;
  to: string;
  /** Клик по заголовку группы-периода — зум в подпериод (не для дней). */
  onZoom: (from: string, to: string) => void;
}) {
  const dayMap = useMemo(() => buildDayMap(days), [days]);
  const spanDays = diffDaysCivil(to, from) + 1;
  const unit = unitForSpan(spanDays);
  const groups = useMemo(
    () => sliceRange(from, to, unit).map((c) => ({ ...c, agg: aggregateRange(dayMap, c.from, c.to) })),
    [dayMap, from, to, unit],
  );
  const totals = useMemo(() => aggregateRange(dayMap, from, to), [dayMap, from, to]);
  const zoomable = unit !== "day";
  const nCats = CATEGORY_KEYS.length;

  // «Итого» — первая группа слева, чтобы сводка была видна без скролла;
  // дальше подпериоды слева направо (свайп вправо — как листание excel).
  const allGroups: Array<{ key: string; label: string; agg: RangeAgg; zoom?: { from: string; to: string } }> = [
    { key: "__total__", label: "Итого", agg: totals },
    ...groups.map((g) => ({
      key: g.from,
      label: columnLabel(unit, g.from, g.to),
      agg: g.agg,
      zoom: zoomable ? { from: g.from, to: g.to } : undefined,
    })),
  ];

  return (
    <div className="glass-panel rounded-2xl p-5 border border-white/5 min-w-0">
      <h3 className="text-slate-300 font-semibold tracking-wide text-xs uppercase mb-4">
        <span className="text-blue-400">{title}</span>
        <span className="text-slate-500 ml-2">{fmtDM(from)}–{fmtDM(to)}.{to.slice(0, 4)}</span>
      </h3>
      <div className="overflow-x-auto">
        <table className="text-sm border-collapse">
          <thead>
            {/* Строка 1: периоды (merged на ширину группы категорий). */}
            <tr className="text-[11px]">
              <th className={`${STICKY_CELL} min-w-[170px]`} />
              {allGroups.map((g) => (
                <th
                  key={g.key}
                  colSpan={nCats}
                  className="py-2 px-4 text-center font-semibold text-slate-200 border-l border-white/10 bg-white/[0.03] whitespace-nowrap"
                >
                  {g.zoom ? (
                    <button
                      onClick={() => onZoom(g.zoom!.from, g.zoom!.to)}
                      title="Открыть период подробнее"
                      className="hover:text-blue-300 transition-colors underline decoration-dotted decoration-slate-600 underline-offset-2"
                    >
                      {g.label}
                    </button>
                  ) : (
                    g.label
                  )}
                </th>
              ))}
            </tr>
            {/* Строка 2: категории внутри каждой группы. */}
            <tr className="text-[10px] uppercase tracking-wider text-slate-500 border-b border-white/10">
              <th className={`${STICKY_CELL} text-left py-1.5 px-2 font-medium`}>Метрика</th>
              {allGroups.map((g) =>
                CATEGORY_KEYS.map((k, i) => (
                  <th
                    key={`${g.key}:${k || "none"}`}
                    className={`py-1.5 px-4 text-right font-medium whitespace-nowrap ${i === 0 ? "border-l border-white/10" : ""}`}
                  >
                    <span className="inline-flex items-center gap-1">
                      <CatDot k={k} />
                      {k === "" ? "Без" : k}
                    </span>
                  </th>
                )),
              )}
            </tr>
          </thead>
          <tbody>
            {/* «Всего лидов» — одно число на группу (merged, как в excel). */}
            <tr className="border-b border-white/[0.04] bg-white/[0.02]">
              <td className={`${STICKY_CELL} py-1.5 px-2 whitespace-nowrap text-xs text-white font-semibold`}>
                Всего лидов
              </td>
              {allGroups.map((g) => (
                <td
                  key={g.key}
                  colSpan={nCats}
                  className="py-1.5 px-2 text-center text-white font-semibold tabular-nums border-l border-white/10"
                >
                  {g.agg.totalLeads}
                </td>
              ))}
            </tr>
            {METRIC_ROWS.map((row) => (
              <tr key={row.id} className="border-b border-white/[0.04] hover:bg-white/[0.02] transition-colors">
                <td className={`${STICKY_CELL} py-1.5 px-2 whitespace-nowrap text-xs text-slate-300`}>
                  {row.label}
                </td>
                {allGroups.map((g) =>
                  CATEGORY_KEYS.map((k, i) => {
                    const muted = metricMuted(row.id, k, g.agg);
                    return (
                      <td
                        key={`${g.key}:${k || "none"}`}
                        className={`py-2 px-4 text-right tabular-nums cursor-help whitespace-nowrap ${i === 0 ? "border-l border-white/10" : ""} ${muted ? "text-slate-600" : "text-slate-200"}`}
                        title={cellTitle(CAT_LABEL[k], g.agg.byCat[k], g.agg.totalLeads)}
                      >
                        {metricCell(row.id, k, g.agg)}
                      </td>
                    );
                  }),
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ==================== Data fetching ====================

function useCategoryDays(funnel: Funnel, from: string | null, to: string | null) {
  // Ответ хранится с ключом запроса: пока ключ не совпадает с параметрами,
  // наружу отдаётся null — данные другого окна не мелькают, и не нужен
  // синхронный сброс state в эффекте (react-hooks/set-state-in-effect).
  const [result, setResult] = useState<{ key: string; days: DayRow[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = from && to ? `${funnel}:${from}:${to}` : null;

  useEffect(() => {
    if (!key || !from || !to) return;
    const ac = new AbortController();
    const run = async () => {
      setLoading(true);
      setError(null);
      try {
        const r = await fetch(`/api/category-dynamics?funnel=${funnel}&from=${from}&to=${to}`, { signal: ac.signal });
        if (!r.ok) throw new Error(`API error ${r.status}: ${await r.text()}`);
        const j = (await r.json()) as ApiResponse;
        setResult({ key, days: j.days ?? [] });
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") return;
        setError(String(e));
      } finally {
        setLoading(false);
      }
    };
    run();
    return () => ac.abort();
  }, [key, funnel, from, to]);

  return {
    // data — только свежий ответ текущих параметров; lastData — последний
    // успешный (любого окна): им рендерим таблицу во время подгрузки, чтобы
    // листание периода не схлопывало вкладку в полноэкранный лоадер
    // (stale-while-revalidate, как на Звонках).
    data: result && result.key === key ? result.days : null,
    lastData: result?.days ?? null,
    loading,
    error,
  };
}

// ==================== Component ====================

export default function CategoryDynamicsTab() {
  // Дефолт — текущий месяц (колонки-недели).
  const [range, setRange] = useState<{ start: Date; end: Date }>(() => {
    const today = todayCivil();
    return { start: berlinCivilDate(`${today.slice(0, 7)}-01`), end: todayBerlinDate() };
  });
  const [funnel, setFunnel] = useState<Funnel>("buh");
  const [compareOn, setCompareOn] = useState(false);
  // Период B (сравнение): дефолт — предыдущее окно той же длины, что A.
  const [rangeB, setRangeB] = useState<{ start: Date; end: Date } | null>(null);
  // Стек зума (клик по колонке): хранит окна, в которые можно вернуться.
  const [zoomStack, setZoomStack] = useState<Array<{ start: Date; end: Date }>>([]);
  // Активный пресет: подсвечивается в тумблере; стрелки ‹ › листают именно
  // неделю/месяц/год целиком. null = произвольный диапазон из календаря.
  const [preset, setPreset] = useState<"week" | "month" | "year" | null>("month");

  const fromA = formatDate(range.start);
  const toA = formatDate(range.end);

  // Предыдущее окно той же длины: база для KPI-дельт, и дефолт периода B.
  const prevWindow = useMemo(() => {
    const span = diffDaysCivil(toA, fromA) + 1;
    const end = addDaysCivil(fromA, -1);
    return { from: addDaysCivil(end, -(span - 1)), to: end };
  }, [fromA, toA]);
  const effB = rangeB ?? { start: berlinCivilDate(prevWindow.from), end: berlinCivilDate(prevWindow.to) };
  const fromB = formatDate(effB.start);
  const toB = formatDate(effB.end);

  const a = useCategoryDays(funnel, fromA, toA);
  // Сравнительный период всегда загружен: без «Сравнить» он кормит KPI-дельты
  // (vs предыдущее окно), со «Сравнить» — таблицу B (тот же запрос).
  const b = useCategoryDays(funnel, fromB, toB);

  // Во время подгрузки нового окна показываем предыдущие данные (см. lastData).
  const aDays = a.data ?? a.lastData;
  const bDays = b.data ?? b.lastData;

  const totalsA = useMemo(
    () => (aDays ? aggregateRange(buildDayMap(aDays), fromA, toA) : null),
    [aDays, fromA, toA],
  );
  const totalsB = useMemo(
    () => (bDays ? aggregateRange(buildDayMap(bDays), fromB, toB) : null),
    [bDays, fromB, toB],
  );

  // Топ-категория периода A (среди размеченных; «Без метки» — не категория).
  const topCat = useMemo(() => {
    if (!totalsA || totalsA.totalLeads === 0) return null;
    let best: CategoryKey | null = null;
    for (const k of CATEGORY_KEYS) {
      if (k === "") continue;
      if (!best || totalsA.byCat[k].leads > totalsA.byCat[best].leads) best = k;
    }
    return best && totalsA.byCat[best].leads > 0 ? best : null;
  }, [totalsA]);

  const applyRange = (start: Date, end: Date) => {
    setRange({ start, end });
    setRangeB(null);
    setZoomStack([]);
  };

  /** Диапазон пресета вокруг anchor-даты (civil). Будущее клипается сегодняшним днём. */
  const presetRange = (p: "week" | "month" | "year", anchor: string): { from: string; to: string } => {
    const today = todayCivil();
    let f: string;
    let t: string;
    if (p === "week") {
      f = addDaysCivil(anchor, -dowMonday(anchor));
      t = addDaysCivil(f, 6);
    } else if (p === "month") {
      f = `${anchor.slice(0, 7)}-01`;
      const [y, m] = [Number(anchor.slice(0, 4)), Number(anchor.slice(5, 7))];
      t = `${anchor.slice(0, 7)}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;
    } else {
      f = `${anchor.slice(0, 4)}-01-01`;
      t = `${anchor.slice(0, 4)}-12-31`;
    }
    return { from: f, to: t > today ? today : t };
  };

  const applyPreset = (p: "week" | "month" | "year") => {
    const r = presetRange(p, todayCivil());
    setPreset(p);
    applyRange(berlinCivilDate(r.from), berlinCivilDate(r.to));
  };

  // Стрелки: при активном пресете листаем календарную единицу целиком
  // (предыдущая полная неделя / месяц / год), иначе — сдвиг на длину окна.
  const shiftRange = (dir: -1 | 1) => {
    const today = todayCivil();
    if (preset) {
      // Якорь соседнего периода: день сразу за календарной границей текущего
      // (для «вперёд» — за НЕклипнутым концом: окно могло быть обрезано сегодня).
      const anchor = dir === 1
        ? addDaysCivil(presetEnd(preset, fromA), 1)
        : addDaysCivil(presetRange(preset, fromA).from, -1);
      if (anchor > today) return; // в будущее не листаем
      const next = presetRange(preset, anchor);
      applyRange(berlinCivilDate(next.from), berlinCivilDate(next.to));
      return;
    }
    const span = diffDaysCivil(toA, fromA) + 1;
    applyRange(
      berlinCivilDate(addDaysCivil(fromA, dir * span)),
      berlinCivilDate(addDaysCivil(toA, dir * span)),
    );
  };

  /** Календарный конец единицы пресета БЕЗ клипа сегодняшним днём. */
  const presetEnd = (p: "week" | "month" | "year", anchor: string): string => {
    if (p === "week") return addDaysCivil(addDaysCivil(anchor, -dowMonday(anchor)), 6);
    if (p === "month") {
      const [y, m] = [Number(anchor.slice(0, 4)), Number(anchor.slice(5, 7))];
      return `${anchor.slice(0, 7)}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;
    }
    return `${anchor.slice(0, 4)}-12-31`;
  };

  // Зум по клику на колонку таблицы A: текущее окно — в стек, окно = колонка.
  const zoomInto = (f: string, t: string) => {
    setZoomStack((prev) => [...prev, range]);
    setRange({ start: berlinCivilDate(f), end: berlinCivilDate(t) });
    setRangeB(null);
    setPreset(null);
  };
  const zoomBack = () => {
    setZoomStack((prev) => {
      const next = [...prev];
      const last = next.pop();
      if (last) { setRange(last); setRangeB(null); }
      return next;
    });
  };

  if (a.loading && !aDays) return <DinoLoader />;

  if (a.error && !aDays) {
    return (
      <div className="glass-panel rounded-2xl p-8 border border-red-500/20 text-center">
        <AlertTriangle className="w-10 h-10 text-red-400 mx-auto mb-3" />
        <p className="text-red-400 text-sm">{a.error}</p>
      </div>
    );
  }

  const deltaLabel = compareOn ? "vs период B" : "vs пред. период";

  // Подпись окна между стрелками: для пресетов — имя календарной единицы
  // («Июль 2026», «14–20 июля 2026», «2026 год»), для произвольного — даты.
  const rangeLabel = (() => {
    const y = fromA.slice(0, 4);
    if (preset === "month") return `${MONTH_NAMES[Number(fromA.slice(5, 7)) - 1]} ${y}`;
    if (preset === "year") return `${y} год`;
    if (preset === "week") {
      const wEnd = presetEnd("week", fromA);
      // Внутри месяца — «14–20 июля»; через границу — «30 июня – 6 июля».
      return fromA.slice(0, 7) === wEnd.slice(0, 7)
        ? `${Number(fromA.slice(8, 10))}–${fmtDayGen(wEnd)} ${y}`
        : `${fmtDayGen(fromA)} – ${fmtDayGen(wEnd)} ${wEnd.slice(0, 4)}`;
    }
    return `${fmtDM(fromA)} — ${fmtDM(toA)}.${toA.slice(0, 4)}`;
  })();

  return (
    <div className="flex flex-col gap-4 fade-in">
      {/* ── Фильтры ─────────────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-center justify-between">
        <div className="flex items-center gap-2 flex-wrap">
          <CalendarPicker
            mode="range"
            value={{ start: range.start, end: range.end }}
            onChange={(r) => {
              if (!r.start) return;
              setPreset(null); // ручной выбор в календаре = произвольный период
              applyRange(r.start, r.end ?? r.start);
            }}
            onClear={() => applyPreset("month")}
          />
          <div className="flex items-center gap-0.5 bg-slate-900/60 border border-white/10 rounded-lg p-0.5">
            {(["week", "month", "year"] as const).map((p) => (
              <button
                key={p}
                onClick={() => applyPreset(p)}
                className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${preset === p ? "bg-blue-500/20 text-blue-300" : "text-slate-400 hover:text-slate-200"}`}
              >
                {p === "week" ? "Неделя" : p === "month" ? "Месяц" : "Год"}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-0.5 bg-slate-900/60 border border-white/10 rounded-lg p-0.5">
            {(Object.keys(FUNNEL_LABEL) as Funnel[]).map((f) => (
              <button
                key={f}
                onClick={() => setFunnel(f)}
                className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${funnel === f ? "bg-blue-500/20 text-blue-300" : "text-slate-400 hover:text-slate-200"}`}
              >
                {FUNNEL_LABEL[f]}
              </button>
            ))}
          </div>
          {zoomStack.length > 0 && (
            <button
              onClick={zoomBack}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-blue-500/10 text-blue-300 border border-blue-500/20 hover:bg-blue-500/20 transition-colors"
            >
              <Undo2 className="w-3.5 h-3.5" />
              Назад к {(() => {
                const prev = zoomStack[zoomStack.length - 1];
                return `${fmtDM(formatDate(prev.start))}–${fmtDM(formatDate(prev.end))}`;
              })()}
            </button>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button aria-label="Предыдущий период" onClick={() => shiftRange(-1)} className="p-2 rounded-lg text-slate-400 hover:text-white hover:bg-white/5 transition-colors">
            <ChevronLeft className="w-4 h-4" />
          </button>
          <span className="text-sm text-slate-300 font-medium min-w-[150px] text-center">
            {rangeLabel}
          </span>
          <button aria-label="Следующий период" onClick={() => shiftRange(1)} className="p-2 rounded-lg text-slate-400 hover:text-white hover:bg-white/5 transition-colors">
            <ChevronRight className="w-4 h-4" />
          </button>
          {(a.loading || b.loading) && <Loader2 className="w-4 h-4 animate-spin text-blue-400" />}
        </div>
      </div>

      {/* ── KPI периода A ───────────────────────────────────────── */}
      {totalsA && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
          <StatTile
            label="Лиды за период"
            value={String(totalsA.totalLeads)}
            delta={totalsB ? pctDelta(totalsA.totalLeads, totalsB.totalLeads) : null}
            deltaLabel={deltaLabel}
          />
          <StatTile
            label="Продажи"
            value={String(totalsA.totalSales)}
            sub="факт 1-го платежа"
            delta={totalsB ? pctDelta(totalsA.totalSales, totalsB.totalSales) : null}
            deltaLabel={deltaLabel}
          />
          <StatTile
            label="Конверсия в продажу"
            value={fmtPct(totalsA.totalSales, totalsA.totalLeads)}
            delta={totalsB ? ppDelta(totalsA.totalSales, totalsA.totalLeads, totalsB.totalSales, totalsB.totalLeads) : null}
            deltaLabel={deltaLabel}
          />
          <div className="glass-panel rounded-2xl p-4 border border-white/5 min-w-0">
            <p className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">Топ категория по лидам</p>
            <div className="flex items-baseline gap-2 flex-wrap">
              {topCat && <CatDot k={topCat} />}
              <span className="text-2xl font-semibold text-white">{topCat ?? "—"}</span>
              {topCat && (
                <span className="text-xs text-slate-400">
                  {fmtPct(totalsA.byCat[topCat].leads, totalsA.totalLeads)} лидов · конв. {fmtPct(totalsA.byCat[topCat].sales, totalsA.byCat[topCat].leads)}
                </span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Сравнение периодов ──────────────────────────────────── */}
      <div className="flex items-center gap-2 flex-wrap">
        <button
          onClick={() => setCompareOn((v) => !v)}
          className={`px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-colors ${compareOn ? "bg-blue-500/20 text-blue-300 border-blue-500/40" : "bg-slate-900/60 text-slate-400 border-white/10 hover:text-slate-200"}`}
        >
          Сравнить периоды
        </button>
        {compareOn && (
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] font-bold text-slate-500">B</span>
            <CalendarPicker
              mode="range"
              value={{ start: effB.start, end: effB.end }}
              onChange={(r) => {
                if (!r.start) return;
                setRangeB({ start: r.start, end: r.end ?? r.start });
              }}
              onClear={() => setRangeB(null)}
            />
          </div>
        )}
      </div>

      {/* ── Таблицы ──────────────────────────────────────────────
           При сравнении B встаёт ПОД A: таблицы широкие (группы периодов по
           горизонтали), а колонки категорий обеих таблиц выравниваются
           вертикально — сравнивать одну и ту же метрику проще. */}
      <div className="flex flex-col gap-4">
        <GroupsTable
          title={compareOn ? "Период A" : `Категории — ${FUNNEL_LABEL[funnel]}`}
          days={aDays ?? []}
          from={fromA}
          to={toA}
          onZoom={zoomInto}
        />
        {compareOn && (
          b.error ? (
            <div className="glass-panel rounded-2xl p-8 border border-red-500/20 text-center text-red-400 text-sm">{b.error}</div>
          ) : (
            <GroupsTable
              title="Период B"
              days={bDays ?? []}
              from={fromB}
              to={toB}
              onZoom={(f, t) => setRangeB({ start: berlinCivilDate(f), end: berlinCivilDate(t) })}
            />
          )
        )}
      </div>

      {/* ── Методика ────────────────────────────────────────────── */}
      <div className="glass-panel rounded-2xl p-4 border border-white/5 text-xs text-slate-500 leading-relaxed">
        <p>
          <span className="text-slate-300 font-medium">Лиды</span> — по дате создания сделки (Berlin), воронка {FUNNEL_LABEL[funnel]}, без этапа Incoming leads и без причин закрытия
          «Неквал», «Спам», «Предложение сотрудничества», «Дубль госник», «Бух дубль», «Мед дубль» (поле «Причина закрытия — обязательное»).
          {" "}<span className="text-slate-300 font-medium">Продажа</span> — заполнена «Факт. Дата 1-го платежа»; относится к периоду создания лида, даже если платёж пришёл позже.
          {" "}<span className="text-slate-300 font-medium">Без метки</span> = всего − (A+B+C+D+E).
          {" "}Клик по заголовку колонки открывает период подробнее (месяц → недели → дни); наведение на ячейку — все числа категории за колонку.
        </p>
      </div>
    </div>
  );
}
