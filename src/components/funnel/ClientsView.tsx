"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Users, Loader2, TriangleAlert, ArrowUp, ArrowDown, ArrowLeftRight, Trophy, ChartPie, Languages, X, TrendingUp } from "lucide-react";
import { PieChart, Pie, Cell, Tooltip, Legend, ResponsiveContainer, BarChart, Bar, XAxis, YAxis, ComposedChart, Area, Line, CartesianGrid, ReferenceLine, LabelList } from "recharts";
import { addDaysCivil, berlinCivilDate, fmtLocalDate, todayBerlinDate } from "@/lib/utils/date";
import CalendarPicker, { type DateRange } from "@/components/CalendarPicker";
import type { FunnelFiltersState } from "@/lib/funnel/types";
import type {
  ClientRow,
  ClientsResult,
  ClientsReadinessSummary,
  SideReadinessSummary,
  ClientGroup,
  ClientSideReadiness,
} from "@/lib/funnel/clients";
import type { BotDailyPoint, BotTrainingSummary } from "@/lib/funnel/bot-roleplays";
import InfoPopover from "@/components/funnel/InfoPopover";
import ClientDrawer, { NOT_SCORED_MARK } from "@/components/funnel/ClientDrawer";
import FilterSelect from "@/components/funnel/FilterSelect";

// Кеш по периоду — переключение Когорты⇄Клиенты не должно перезагружать таблицу.
const cache = new Map<string, ClientsResult>();

// Сколько строк добавляет «Показать ещё».
const PAGE_SIZE = 50;
// Потолок выдачи бэка (роут принимает limit≤1000). Компьют считает всех, режет
// здесь — без лимита потеряли бы хвост низкого score. Клиентская пагинация ниже
// постранично показывает уже полученный набор.
const FETCH_LIMIT = 1000;

interface Props {
  filters: FunnelFiltersState;
  /** Вертикаль b2g (Бух/Мед/Все) из глобального тоггла. Без неё — бух (legacy). */
  vertical?: "buh" | "med" | "all";
  /** Скрыть корреляции, готовность и клиентские таблицы для точечного доступа. */
  limited?: boolean;
}

const CATEGORY = {
  hot: { label: "Hot", cls: "text-emerald-300 bg-emerald-500/10 border-emerald-500/30" },
  warm: { label: "Warm", cls: "text-amber-300 bg-amber-500/10 border-amber-500/30" },
  cold: { label: "Cold", cls: "text-slate-400 bg-slate-500/10 border-slate-500/20" },
} as const;

const LANG_LABEL: Record<ClientRow["languageBucket"], string> = {
  a1: "A1",
  a2: "A2",
  b1: "B1",
  b2: "B2",
  c1: "C1",
};

// Текст-подсказка «откуда статус»: показывает разбивку готовности по факторам
// (вес + вклад каждого), чтобы Hot/Warm/Cold был объяснимым (ТЗ §8).
function breakdownTitle(c: ClientRow): string {
  const lines = c.factors.map(
    (f) => `  • ${f.label} (${Math.round(f.weight * 100)}%): ${f.present ? f.value : "нет данных"}`,
  );
  return `Готовность ${c.score} → ${CATEGORY[c.category].label}\nИз чего складывается:\n${lines.join("\n")}`;
}
const LANG_RANK: Record<ClientRow["languageBucket"], number> = {
  a1: 0,
  a2: 1,
  b1: 2,
  b2: 3,
  c1: 4,
};

function scoreColor(s5: number): string {
  if (s5 >= 4) return "text-emerald-300";
  if (s5 === 3) return "text-amber-300";
  return "text-rose-300";
}

// ОКК 0..100 → цвет (как scoreColor, но по 100-балльной шкале).
function okkColor(okk: number): string {
  if (okk >= 80) return "text-emerald-300";
  if (okk >= 60) return "text-amber-300";
  return "text-rose-300";
}

function SideCell({ side }: { side: ClientSideReadiness }) {
  // Прочерк только когда ролевок не было вовсе. Проведённые, но НЕ оценённые
  // (score=null) показываем маркером ○/⚠ — иначе такой клиент выглядел бы как
  // «ролевки не было» (см. 104 лида только-с-неоценёнными).
  if (side.attempts.length === 0 && side.notScored.length === 0)
    return <span className="text-slate-600">—</span>;
  const last = side.attempts.length > 0 ? side.attempts[side.attempts.length - 1] : null;
  return (
    <span className="inline-flex items-center gap-1 tabular-nums">
      {last !== null && <span className={`font-semibold ${scoreColor(last)}`}>{last}</span>}
      {side.attempts.length > 1 && (
        <span className="text-[10px] text-slate-500">[{side.attempts.join("→")}]</span>
      )}
      {side.notScored.map((kind, j) => {
        const m = NOT_SCORED_MARK[kind];
        return (
          <span key={`n${j}`} className={`cursor-help ${m.cls}`} title={m.title}>
            {m.ch}
          </span>
        );
      })}
    </span>
  );
}

type SortKey =
  | "name"
  | "status"
  | "manager"
  | "stage_days"
  | "termin"
  | "language"
  | "dc"
  | "aa"
  | "roleplays"
  | "okk"
  | "activity"
  | "score";
type SortState = { key: SortKey; dir: "asc" | "desc" } | null;

function fmtTermin(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "Europe/Berlin",
  });
}

const COLUMNS: {
  key: SortKey;
  label: string;
  align: "left" | "center" | "right";
  value: (c: ClientRow) => number | string;
}[] = [
  { key: "name", label: "Клиент", align: "left", value: (c) => c.name.toLowerCase() },
  { key: "status", label: "Этап", align: "left", value: (c) => (c.status ?? "").toLowerCase() },
  { key: "manager", label: "Менеджер", align: "left", value: (c) => (c.managerName ?? "").toLowerCase() },
  { key: "stage_days", label: "Дней на стадии", align: "right", value: (c) => c.daysOnStage ?? Number.POSITIVE_INFINITY },
  { key: "termin", label: "Термин", align: "center", value: (c) => (c.terminAtIso ? Date.parse(c.terminAtIso) : Number.POSITIVE_INFINITY) },
  { key: "language", label: "Язык", align: "center", value: (c) => LANG_RANK[c.languageBucket] },
  { key: "dc", label: "ДЦ", align: "center", value: (c) => c.dc.latest ?? -1 },
  { key: "aa", label: "АА", align: "center", value: (c) => c.aa.latest ?? -1 },
  { key: "roleplays", label: "С ботом", align: "center", value: (c) => c.botRoleplayCount },
  { key: "okk", label: "ОКК", align: "center", value: (c) => c.okkDeal ?? -1 },
  { key: "activity", label: "Активность", align: "right", value: (c) => c.daysSinceLastTouch ?? Number.POSITIVE_INFINITY },
  { key: "score", label: "Готовность", align: "right", value: (c) => c.score },
];

function compare(a: number | string, b: number | string): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), "ru");
}

function countCats(clients: ClientRow[]): { hot: number; warm: number; cold: number } {
  const c = { hot: 0, warm: 0, cold: 0 };
  for (const x of clients) c[x.category] += 1;
  return c;
}

// Клиентский фильтр группы по менеджеру+этапу (данные уже загружены целиком, ~250
// строк). "" → без фильтра по этому полю. Пересчитываем total/shown/categories
// под отфильтрованных (ТЗ со звонка 2026-07-13: нужны именно эти два фильтра).
function filterGroup(group: ClientGroup, manager: string, stage: string): ClientGroup {
  if (!manager && !stage) return group;
  const clients = group.clients.filter(
    (c) => (!manager || c.managerName === manager) && (!stage || c.status === stage),
  );
  return { clients, total: clients.length, shown: clients.length, categories: countCats(clients) };
}

function ClientTable({
  group,
  title,
  icon,
  onRowClick,
  onFilterManager,
  onFilterStage,
}: {
  group: ClientGroup;
  title: string;
  icon: ReactNode;
  onRowClick: (c: ClientRow) => void;
  /** Клик по значению «Этап»/«Менеджер» в строке — фильтрует по нему (запрос
   *  со звонка 2026-07-13: «просто менеджер прям тыкаешь», без отдельного дропдауна). */
  onFilterManager: (name: string) => void;
  onFilterStage: (status: string) => void;
}) {
  const [sort, setSort] = useState<SortState>(null);

  // 3-состояния: нет → desc → asc → нет (дефолт — порядок бэка = по score).
  const cycleSort = (key: SortKey) =>
    setSort((prev) => {
      if (!prev || prev.key !== key) return { key, dir: "desc" };
      if (prev.dir === "desc") return { key, dir: "asc" };
      return null;
    });

  const rows = useMemo(() => {
    if (!sort) return group.clients;
    const col = COLUMNS.find((c) => c.key === sort.key);
    if (!col) return group.clients;
    const sorted = [...group.clients].sort((x, y) => compare(col.value(x), col.value(y)));
    return sort.dir === "desc" ? sorted.reverse() : sorted;
  }, [group.clients, sort]);

  // Клиентская пагинация: показываем первые `visible`, «Показать ещё» добавляет PAGE_SIZE.
  const [visible, setVisible] = useState(PAGE_SIZE);
  // Новая порция данных (смена периода) — сбрасываем на первую страницу. Приём
  // React «скорректировать state при смене пропа» без эффекта: сверяем с предыдущей
  // ссылкой прямо в рендере (см. react.dev/learn/you-might-not-need-an-effect).
  const [seenClients, setSeenClients] = useState(group.clients);
  if (seenClients !== group.clients) {
    setSeenClients(group.clients);
    setVisible(PAGE_SIZE);
  }
  const shownRows = rows.slice(0, visible);
  const hasMore = visible < rows.length;

  if (group.shown === 0) return null;

  return (
    <div className="glass-panel rounded-2xl border border-white/5 overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-white/5">
        {icon}
        <span className="text-sm font-medium text-slate-200">{title}</span>
        <span className="text-xs text-slate-500 tabular-nums">
          показано {Math.min(visible, rows.length)} из {group.total}
        </span>
      </div>
      <div className="overflow-auto max-h-[440px]">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-slate-900/80 backdrop-blur z-10">
            <tr className="text-[10px] uppercase tracking-widest font-semibold text-slate-500">
              {COLUMNS.map((col) => {
                const active = sort?.key === col.key;
                return (
                  <th
                    key={col.key}
                    onClick={() => cycleSort(col.key)}
                    className={`px-3 py-2 font-semibold cursor-pointer select-none hover:text-slate-300 text-${col.align}`}
                  >
                    <span className={`inline-flex items-center gap-1 ${col.align === "right" ? "flex-row-reverse" : ""}`}>
                      {col.label}
                      {active && sort?.dir === "desc" && <ArrowDown className="w-3 h-3" />}
                      {active && sort?.dir === "asc" && <ArrowUp className="w-3 h-3" />}
                    </span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {shownRows.map((c) => {
              const cat = CATEGORY[c.category];
              return (
                <tr
                  key={c.leadId}
                  tabIndex={0}
                  onClick={() => onRowClick(c)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onRowClick(c);
                    }
                  }}
                  className="border-t border-white/5 hover:bg-blue-500/5 focus:bg-blue-500/10 cursor-pointer outline-none"
                >
                  <td className="px-3 py-2 text-slate-200 max-w-[200px] truncate">{c.name}</td>
                  <td className="px-3 py-2 max-w-[190px] truncate">
                    {c.status ? (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onFilterStage(c.status as string);
                        }}
                        className="text-slate-400 hover:text-blue-300 hover:underline"
                        title="Отфильтровать по этому этапу"
                      >
                        {c.status}
                      </button>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-3 py-2 max-w-[150px] truncate">
                    {c.managerName ? (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onFilterManager(c.managerName as string);
                        }}
                        className="text-slate-400 hover:text-blue-300 hover:underline"
                        title="Отфильтровать по этому менеджеру"
                      >
                        {c.managerName}
                      </button>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-3 py-2 text-right text-slate-400 tabular-nums">
                    {c.daysOnStage === null ? "—" : `${c.daysOnStage}д`}
                  </td>
                  <td className="px-3 py-2 text-center text-slate-300 tabular-nums">{fmtTermin(c.terminAtIso)}</td>
                  <td className="px-3 py-2 text-center text-slate-300">{LANG_LABEL[c.languageBucket]}</td>
                  <td className="px-3 py-2 text-center"><SideCell side={c.dc} /></td>
                  <td className="px-3 py-2 text-center"><SideCell side={c.aa} /></td>
                  <td className="px-3 py-2 text-center text-slate-300 tabular-nums" title="тренировок с ботом">
                    {c.botRoleplayCount || <span className="text-slate-600">—</span>}
                  </td>
                  <td className="px-3 py-2 text-center tabular-nums" title="средний ОКК звонков по сделке (из ОКК-системы)">
                    {c.okkDeal === null ? (
                      <span className="text-slate-600">—</span>
                    ) : (
                      <span className={okkColor(c.okkDeal)}>{Math.round(c.okkDeal)}</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right text-slate-400 tabular-nums">
                    {c.daysSinceLastTouch === null
                      ? "—"
                      : c.daysSinceLastTouch === 0
                        ? "сегодня"
                        : `${c.daysSinceLastTouch}д`}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <span className="inline-flex items-center gap-2 cursor-help" title={breakdownTitle(c)}>
                      <span className="font-semibold text-slate-100 tabular-nums">{c.score}</span>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded-md border ${cat.cls}`}>{cat.label}</span>
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {hasMore && (
        <div className="border-t border-white/5 px-4 py-2 flex items-center justify-center gap-3">
          <button
            onClick={() => setVisible((v) => v + PAGE_SIZE)}
            className="text-xs text-slate-300 hover:text-white px-3 py-1 rounded-md border border-white/10 hover:border-white/20"
          >
            Показать ещё {Math.min(PAGE_SIZE, rows.length - visible)}
          </button>
          <button
            onClick={() => setVisible(rows.length)}
            className="text-xs text-slate-500 hover:text-slate-300"
          >
            Показать все ({rows.length})
          </button>
        </div>
      )}
    </div>
  );
}

// Распределение клиентов по числу тренировок С БОТОМ. Считается из загруженных
// клиентов (актуальных по фильтру даты термина).
// Сегмент «0 ролевок» разбит на два: зарегистрирован в боте, но не тренировался,
// и вообще не в боте — это разные сигналы (первых надо «толкнуть» тренироваться,
// вторых — сначала завести в бот). match — предикат вместо min/max диапазона.
const RP_BUCKETS: { key: string; label: string; color: string; match: (c: ClientRow) => boolean }[] = [
  { key: "in0", label: "В боте, 0", color: "#64748b", match: (c) => c.botRoleplayCount === 0 && c.botRegistered },
  { key: "out", label: "Не в боте", color: "#334155", match: (c) => c.botRoleplayCount === 0 && !c.botRegistered },
  { key: "1-2", label: "1–2", color: "#f0b63d", match: (c) => c.botRoleplayCount >= 1 && c.botRoleplayCount <= 2 },
  { key: "3-4", label: "3–4", color: "#8fbe91", match: (c) => c.botRoleplayCount >= 3 && c.botRoleplayCount <= 4 },
  { key: "5+", label: "5+", color: "#18a98b", match: (c) => c.botRoleplayCount >= 5 },
];

// Строка drill-таблицы: имя (ссылка на Kommo) + основная метрика (про ролевки) +
// опционально готовность (вторичный контекст, с разбивкой в тултипе).
interface DrillRow {
  key: string | number;
  name: string;
  kommoUrl: string;
  primary: string;
  readiness?: { score: number; category: ClientRow["category"]; title: string };
}
type DrillFn = (title: string, rows: DrillRow[]) => void;

// ClientRow → DrillRow с метрикой «N ролевок с ботом» + готовность.
function clientToDrillRow(c: ClientRow): DrillRow {
  return {
    key: c.leadId,
    name: c.name,
    kommoUrl: c.kommoUrl,
    primary: `${c.botRoleplayCount} рол. с ботом`,
    readiness: { score: c.score, category: c.category, title: breakdownTitle(c) },
  };
}

// Заглушка бот-панелей в режиме Мед: у мед-направления будет СВОЙ бот ролевок
// (решение юзера 2026-07-06); буховый бот к мед-клиентам неприменим, поэтому
// графики показываем пустыми, а не с ложными «0 тренировок».
function MedBotPlaceholder() {
  return (
    <div className="h-52 flex flex-col items-center justify-center text-center text-xs text-slate-500 gap-1">
      <span>Мед-бот ролевок ещё не подключён.</span>
      <span>График заполнится после запуска бота для мед-направления.</span>
    </div>
  );
}

function RoleplayDistribution({ clients, onDrill, vertical }: { clients: ClientRow[]; onDrill: DrillFn; vertical?: "buh" | "med" | "all" }) {
  const all = clients;
  const isMed = vertical === "med";
  // Graceful: пока данных о регистрациях нет (таблица bot_users пуста/не
  // наполнена), не делим «0» — показываем единый сегмент «0 ролевок». Как только
  // регистрации появятся (есть хоть один botRegistered) — авто-разбивка на два.
  const buckets = useMemo(() => {
    const hasReg = all.some((c) => c.botRegistered);
    if (hasReg) return RP_BUCKETS;
    return [
      { key: "0", label: "0 ролевок", color: "#64748b", match: (c: ClientRow) => c.botRoleplayCount === 0 },
      ...RP_BUCKETS.filter((b) => b.key !== "in0" && b.key !== "out"),
    ];
  }, [all]);
  const dist = useMemo(
    () =>
      buckets.map((b) => ({
        key: b.key,
        label: b.label,
        color: b.color,
        value: all.filter(b.match).length,
      })),
    [all, buckets],
  );
  const total = dist.reduce((s, d) => s + d.value, 0);
  if (!isMed && total === 0) return null;

  if (isMed) {
    return (
      <div className="glass-panel rounded-2xl border border-white/5 p-4">
        <div className="flex items-center gap-2">
          <ChartPie className="w-4 h-4 text-blue-400" />
          <span className="text-sm font-medium text-slate-200">Тренировки с ботом: распределение клиентов</span>
        </div>
        <MedBotPlaceholder />
      </div>
    );
  }

  return (
    <div className="glass-panel rounded-2xl border border-white/5 p-4">
      <div className="flex items-center gap-2">
        <ChartPie className="w-4 h-4 text-blue-400" />
        <span className="text-sm font-medium text-slate-200">Тренировки с ботом: распределение клиентов</span>
        <span className="text-xs text-slate-500 tabular-nums">{total} клиентов</span>
      </div>
      <div className="text-[11px] text-slate-500 mb-1">
        сколько клиентов сделали столько тренировок · клик по сектору — список
      </div>
      <div className="h-52">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={dist}
              dataKey="value"
              nameKey="label"
              innerRadius={48}
              outerRadius={78}
              paddingAngle={2}
              className="cursor-pointer"
              onClick={(d) => {
                const e = (d?.payload?.payload ?? d?.payload ?? d) as { key?: string };
                const b = buckets.find((x) => x.key === e.key);
                if (!b) return;
                const rows = all
                  .filter(b.match)
                  .sort((a, z) => z.botRoleplayCount - a.botRoleplayCount)
                  .map(clientToDrillRow);
                onDrill(`Тренировок с ботом: ${b.label}`, rows);
              }}
            >
              {dist.map((d) => (
                <Cell key={d.label} fill={d.color} stroke="transparent" />
              ))}
            </Pie>
            <Tooltip
              contentStyle={{ background: "#0f172a", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, fontSize: 12 }}
              itemStyle={{ color: "#e2e8f0" }}
              labelStyle={{ color: "#94a3b8" }}
              formatter={(v) => {
                const n = typeof v === "number" ? v : 0;
                return [`${n} (${total ? Math.round((n / total) * 100) : 0}%)`, "клиентов"];
              }}
            />
            <Legend
              wrapperStyle={{ fontSize: 12, color: "#cbd5e1" }}
              formatter={(value, entry) => `${value}: ${(entry?.payload as { value?: number })?.value ?? 0}`}
            />
          </PieChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// A1 («не квал») исключён из аналитики — в распределении не показываем.
const LANG_ORDER: ClientRow["languageBucket"][] = ["a2", "b1", "b2", "c1"];

function LanguageLevels({ clients, onDrill }: { clients: ClientRow[]; onDrill: DrillFn }) {
  const all = clients;
  const dist = useMemo(
    () => LANG_ORDER.map((b) => ({ label: LANG_LABEL[b], bucket: b, value: all.filter((c) => c.languageBucket === b).length })),
    [all],
  );
  const total = dist.reduce((s, d) => s + d.value, 0);
  if (total === 0) return null;

  return (
    <div className="glass-panel rounded-2xl border border-white/5 p-4">
      <div className="flex items-center gap-2 mb-1">
        <Languages className="w-4 h-4 text-blue-400" />
        <span className="text-sm font-medium text-slate-200">Уровни языка</span>
      </div>
      <div className="h-52">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={dist} margin={{ top: 8, right: 8, bottom: 0, left: -20 }}>
            <XAxis dataKey="label" tick={{ fill: "#94a3b8", fontSize: 12 }} axisLine={false} tickLine={false} />
            <YAxis allowDecimals={false} tick={{ fill: "#94a3b8", fontSize: 12 }} axisLine={false} tickLine={false} />
            <Tooltip
              cursor={{ fill: "rgba(255,255,255,0.04)" }}
              contentStyle={{ background: "#0f172a", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, fontSize: 12 }}
              itemStyle={{ color: "#e2e8f0" }}
              labelStyle={{ color: "#94a3b8" }}
              formatter={(v) => [typeof v === "number" ? v : 0, "клиентов"]}
            />
            <Bar
              dataKey="value"
              fill="#60a5fa"
              radius={[4, 4, 0, 0]}
              className="cursor-pointer"
              onClick={(d) => {
                const e = (d?.payload ?? d) as { label?: string; bucket?: ClientRow["languageBucket"] };
                if (!e.bucket) return;
                const rows = all
                  .filter((c) => c.languageBucket === e.bucket)
                  .sort((a, b) => b.score - a.score)
                  .map(clientToDrillRow);
                onDrill(`Язык: ${e.label ?? ""}`, rows);
              }}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

/** Период по умолчанию — текущий календарный месяц с 1-го числа по сегодня. */
function defaultTrainingRange(): { start: Date; end: Date } {
  const today = fmtLocalDate(todayBerlinDate());
  return { start: berlinCivilDate(`${today.slice(0, 7)}-01`), end: todayBerlinDate() };
}

/** Сдвиг ISO-даты на календарный месяц с прижатием дня к концу месяца:
 * 31.07 → 30.06, 31.03 → 28/29.02. Это и есть сравнение периодов, а не дней. */
function shiftTrainingMonth(iso: string, offset: number): string {
  const year = Number(iso.slice(0, 4));
  const month = Number(iso.slice(5, 7)) - 1;
  const day = Number(iso.slice(8, 10));
  const target = new Date(Date.UTC(year, month + offset, 1));
  const targetYear = target.getUTCFullYear();
  const targetMonth = target.getUTCMonth();
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  return `${targetYear}-${String(targetMonth + 1).padStart(2, "0")}-${String(Math.min(day, lastDay)).padStart(2, "0")}`;
}

type TrainingRange = { start: Date; end: Date };

interface TrainingChartPoint {
  index: number;
  label: string;
  aDate: string | null;
  bDate: string | null;
  totalA: number | null;
  totalB: number | null;
  usersA: number | null;
  usersB: number | null;
  lvl1A: number | null;
  lvl1B: number | null;
  lvl2A: number | null;
  lvl2B: number | null;
}

interface TrainingApiResponse {
  points: BotDailyPoint[];
  summary: BotTrainingSummary;
}

type TrainingMetric = "total" | "users";

/** API возвращает только дни с тренировками. Для честного сравнения периодов
 *  дополняем пропуски нулями, иначе 6 июня могло бы совместиться с 5 июля. */
function padTrainingDays(from: string, to: string, points: BotDailyPoint[]): BotDailyPoint[] {
  const byDay = new Map(points.map((p) => [p.day, p]));
  const out: BotDailyPoint[] = [];
  let day = from;
  let guard = 0;
  while (day <= to && guard < 800) {
    out.push(byDay.get(day) ?? {
      day,
      total: 0,
      users: 0,
      lvl1: 0,
      lvl2: 0,
    });
    day = addDaysCivil(day, 1);
    guard += 1;
  }
  return out;
}

/** Нарастающий итог строится строго из тех же дневных значений. Для users это
 *  сумма дневных уникальных: клиент, тренировавшийся в разные дни, участвует в
 *  каждом таком дне — ровно как договорились для обычного графика. */
function accumulateTrainingDays(points: BotDailyPoint[]): BotDailyPoint[] {
  let total = 0;
  let users = 0;
  let lvl1 = 0;
  let lvl2 = 0;
  return points.map((p) => {
    total += p.total;
    users += p.users;
    lvl1 += p.lvl1;
    lvl2 += p.lvl2;
    return { ...p, total, users, lvl1, lvl2 };
  });
}

/** Период B накладывается на A по номеру дня: день 1 ↔ день 1. Это позволяет
 *  сравнить, например, июль (31 день) с июнем (30 дней). */
function mergeTrainingPeriods(
  periodA: BotDailyPoint[],
  periodB: BotDailyPoint[] | null,
  cumulative: boolean,
): TrainingChartPoint[] {
  const a = cumulative ? accumulateTrainingDays(periodA) : periodA;
  const b = periodB ? (cumulative ? accumulateTrainingDays(periodB) : periodB) : null;
  const length = Math.max(a.length, b?.length ?? 0);
  return Array.from({ length }, (_, index) => {
    const pa = a[index];
    const pb = b?.[index];
    return {
      index,
      label: b ? String(index + 1) : (pa?.day.slice(5) ?? String(index + 1)),
      aDate: pa?.day ?? null,
      bDate: pb?.day ?? null,
      totalA: pa?.total ?? null,
      totalB: pb?.total ?? null,
      usersA: pa?.users ?? null,
      usersB: pb?.users ?? null,
      lvl1A: pa?.lvl1 ?? null,
      lvl1B: pb?.lvl1 ?? null,
      lvl2A: pa?.lvl2 ?? null,
      lvl2B: pb?.lvl2 ?? null,
    };
  });
}

function shortTrainingDate(day: string | null): string {
  return day ? day.slice(8, 10) + "." + day.slice(5, 7) : "—";
}

function trainingRangeLabel(from: string, to: string): string {
  return `${shortTrainingDate(from)}–${shortTrainingDate(to)}`;
}

function TrainingCompareTooltip({ active, payload, metric, cumulative }: {
  active?: boolean;
  payload?: Array<{ payload?: TrainingChartPoint }>;
  metric: TrainingMetric;
  cumulative: boolean;
}) {
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;
  const rows = [
    { key: "A", day: point.aDate, value: metric === "total" ? point.totalA : point.usersA, lvl1: point.lvl1A, lvl2: point.lvl2A },
    { key: "B", day: point.bDate, value: metric === "total" ? point.totalB : point.usersB, lvl1: point.lvl1B, lvl2: point.lvl2B },
  ].filter((r) => r.day !== null && r.value !== null);
  return (
    <div style={{ background: "#0f172a", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, fontSize: 12, padding: "7px 10px" }}>
      <div style={{ color: "#94a3b8", marginBottom: 4 }}>
        День {point.index + 1}{cumulative ? " · нарастающим итогом" : ""}
      </div>
      {rows.map((r) => (
        <div key={r.key} style={{ color: r.key === "A" ? "#e2e8f0" : "#94a3b8", marginTop: 2 }}>
          <b>{r.key}</b> · {shortTrainingDate(r.day)}: <b>{r.value}</b>{" "}
          {metric === "total" && (
            <span style={{ color: "#64748b" }}>(Ур.1 {r.lvl1} · Ур.2 {r.lvl2})</span>
          )}
        </div>
      ))}
    </div>
  );
}

/** Обычный режим без сравнения: оба показателя одного дня в одной подсказке. */
function TrainingCombinedTooltip({ active, payload, cumulative }: {
  active?: boolean;
  payload?: Array<{ payload?: TrainingChartPoint }>;
  cumulative: boolean;
}) {
  const point = payload?.[0]?.payload;
  if (!active || !point || !point.aDate) return null;
  return (
    <div style={{ background: "#0f172a", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, fontSize: 12, padding: "7px 10px" }}>
      <div style={{ color: "#94a3b8", marginBottom: 4 }}>
        {shortTrainingDate(point.aDate)}{cumulative ? " · нарастающим итогом" : ""}
      </div>
      <div style={{ color: "#e2e8f0" }}>
        Тренировок: <b>{point.totalA ?? 0}</b>{" "}
        <span style={{ color: "#64748b" }}>(Ур.1 {point.lvl1A ?? 0} · Ур.2 {point.lvl2A ?? 0})</span>
      </div>
      <div style={{ color: "#e2e8f0" }}>
        Уникальных клиентов: <b>{point.usersA ?? 0}</b>
      </div>
    </div>
  );
}

/** Единый график из прежней версии: область = тренировки, линия = уникальные. */
function TrainingCombinedChart({
  data,
  cumulative,
  range,
  onPointClick,
}: {
  data: TrainingChartPoint[];
  cumulative: boolean;
  range: string;
  onPointClick: (point: TrainingChartPoint) => void;
}) {
  return (
    <div className="glass-panel rounded-2xl border border-white/5 p-4 min-w-0">
      <div className="flex items-start justify-between gap-2 mb-2 flex-wrap">
        <div>
          <div className="text-sm font-medium text-slate-200">Тренировки и уникальные клиенты</div>
          <div className="text-[11px] text-slate-500">
            {cumulative ? "нарастающим итогом" : "по дням"} · клик по точке — список клиентов
          </div>
        </div>
        <span className="text-[10px] text-slate-500">{range}</span>
      </div>
      <div className="h-56">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart
            data={data}
            margin={{ top: 8, right: 8, bottom: 0, left: -20 }}
            onClick={(state) => {
              // Возвращаем рабочую механику прежнего графика: Recharts 3
              // стабильно отдаёт activeLabel, но не activePayload при клике.
              const label = (state as { activeLabel?: string | number } | null)?.activeLabel;
              const point = label == null
                ? undefined
                : data.find((item) => String(item.label) === String(label));
              if (point) onPointClick(point);
            }}
            className="cursor-pointer"
          >
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
            <XAxis
              dataKey="label"
              tick={{ fill: "#94a3b8", fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              minTickGap={24}
            />
            <YAxis allowDecimals={false} tick={{ fill: "#94a3b8", fontSize: 12 }} axisLine={false} tickLine={false} />
            <Tooltip content={<TrainingCombinedTooltip cumulative={cumulative} />} />
            <Legend wrapperStyle={{ fontSize: 12, color: "#cbd5e1" }} />
            <Area
              type="linear"
              dataKey="totalA"
              stroke="#60a5fa"
              fill="rgba(96,165,250,0.28)"
              name="Тренировки"
              activeDot={{ r: 5 }}
              isAnimationActive={false}
            />
            <Line
              type="linear"
              dataKey="usersA"
              stroke="#f0b63d"
              strokeWidth={2.5}
              dot={false}
              activeDot={{ r: 5 }}
              name="Уникальные клиенты"
              isAnimationActive={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function TrainingMetricChart({
  metric,
  data,
  compareOn,
  cumulative,
  rangeA,
  rangeB,
  onPointClick,
}: {
  metric: TrainingMetric;
  data: TrainingChartPoint[];
  compareOn: boolean;
  cumulative: boolean;
  rangeA: string;
  rangeB: string | null;
  onPointClick: (point: TrainingChartPoint) => void;
}) {
  const isTotal = metric === "total";
  const color = isTotal ? "#60a5fa" : "#f0b63d";
  const keyA = isTotal ? "totalA" : "usersA";
  const keyB = isTotal ? "totalB" : "usersB";
  return (
    <div className="glass-panel rounded-2xl border border-white/5 p-4 min-w-0">
      <div className="flex items-start justify-between gap-2 mb-2 flex-wrap">
        <div>
          <div className="text-sm font-medium text-slate-200">
            {isTotal ? "Количество тренировок" : "Уникальные клиенты"}
          </div>
          <div className="text-[11px] text-slate-500">
            {cumulative ? "нарастающим итогом" : "по дням"} · клик по точке — список клиентов
          </div>
        </div>
        <div className="text-[10px] text-slate-500 flex items-center gap-2 flex-wrap">
          <span>A: {rangeA}</span>
          {compareOn && rangeB && <span className="border-b border-dashed border-slate-500">B: {rangeB}</span>}
        </div>
      </div>
      <div className="h-56">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart
            data={data}
            margin={{ top: 8, right: 8, bottom: 0, left: -20 }}
            onClick={(state) => {
              const label = (state as { activeLabel?: string | number } | null)?.activeLabel;
              const point = label == null
                ? undefined
                : data.find((item) => String(item.label) === String(label));
              if (point) onPointClick(point);
            }}
            className="cursor-pointer"
          >
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
            <XAxis
              dataKey="label"
              tick={{ fill: "#94a3b8", fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              minTickGap={24}
            />
            <YAxis yAxisId="count" allowDecimals={false} tick={{ fill: "#94a3b8", fontSize: 12 }} axisLine={false} tickLine={false} />
            <Tooltip content={<TrainingCompareTooltip metric={metric} cumulative={cumulative} />} />
            {compareOn && <Legend wrapperStyle={{ fontSize: 11, color: "#cbd5e1" }} />}
            <Line
              yAxisId="count"
              type="linear"
              dataKey={keyA}
              name={compareOn ? "Период A" : (isTotal ? "Тренировки" : "Уникальные")}
              stroke={color}
              strokeWidth={2.5}
              dot={false}
              activeDot={{ r: 4 }}
              connectNulls={false}
              isAnimationActive={false}
            />
            {compareOn && (
              <Line
                yAxisId="count"
                type="linear"
                dataKey={keyB}
                name="Период B"
                stroke={color}
                strokeWidth={2}
                strokeDasharray="5 4"
                strokeOpacity={0.65}
                dot={false}
                activeDot={{ r: 4 }}
                connectNulls={false}
                isAnimationActive={false}
              />
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

type TrainingPeriodTotals = {
  trainings: number;
  dailyUnique: number;
  engagedTargetLeads: number;
  targetLeads: number;
  conversionPct: number | null;
};

function trainingPeriodTotals(points: BotDailyPoint[], summary: BotTrainingSummary): TrainingPeriodTotals {
  return {
    trainings: points.reduce((sum, point) => sum + point.total, 0),
    dailyUnique: points.reduce((sum, point) => sum + point.users, 0),
    engagedTargetLeads: summary.engagedTargetLeads,
    targetLeads: summary.targetLeads,
    conversionPct: summary.conversionPct,
  };
}

function TrainingComparisonTable({ pointsA, pointsB, summaryA, summaryB, labelA, labelB }: {
  pointsA: BotDailyPoint[];
  pointsB: BotDailyPoint[];
  summaryA: BotTrainingSummary;
  summaryB: BotTrainingSummary;
  labelA: string;
  labelB: string;
}) {
  const a = trainingPeriodTotals(pointsA, summaryA);
  const b = trainingPeriodTotals(pointsB, summaryB);
  const metrics: Array<{
    key: keyof TrainingPeriodTotals;
    label: string;
    unit: string;
    neutral?: boolean;
    format: (value: number) => string;
  }> = [
    { key: "trainings", label: "Тренировки", unit: "", format: String },
    { key: "dailyUnique", label: "Уникальные за день (сумма)", unit: "", format: String },
    { key: "engagedTargetLeads", label: "Занимались из целевых", unit: "", format: String },
    { key: "targetLeads", label: "Всего целевых лидов", unit: "", neutral: true, format: String },
    { key: "conversionPct", label: "Конверсия в занятие", unit: " п.п.", format: (value) => `${value}%` },
  ];

  return (
    <div className="glass-panel rounded-2xl border border-white/5 p-4 overflow-hidden">
      <div className="flex items-baseline gap-x-3 gap-y-1 flex-wrap mb-3 text-xs font-semibold uppercase tracking-wide">
        <span className="text-slate-300">Сравнение периодов</span>
        <span className="text-blue-400">A · {labelA}</span>
        <span className="text-orange-400">B · {labelB}</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-sm border-collapse">
          <thead>
            <tr className="border-b border-white/10 text-[10px] uppercase tracking-widest font-semibold">
              <th className="py-2 px-3 text-left text-slate-500">Показатель</th>
              <th className="py-2 px-3 text-right text-blue-400">A</th>
              <th className="py-2 px-3 text-right text-orange-400">B</th>
              <th className="py-2 px-3 text-right text-slate-500">Δ · A − B</th>
            </tr>
          </thead>
          <tbody>
            {metrics.map((metric) => {
              const va = a[metric.key];
              const vb = b[metric.key];
              const delta = va === null || vb === null ? null : Math.round((va - vb) * 10) / 10;
              const deltaClass = metric.neutral || delta === null || delta === 0
                ? "text-slate-500"
                : delta > 0 ? "text-emerald-400" : "text-rose-400";
              return (
                <tr key={metric.key} className="border-t border-white/[0.06] hover:bg-white/[0.02]">
                  <td className="py-2.5 px-3 text-slate-300">{metric.label}</td>
                  <td className="py-2.5 px-3 text-right tabular-nums text-blue-300 font-medium">
                    {va === null ? "—" : metric.format(va)}
                  </td>
                  <td className="py-2.5 px-3 text-right tabular-nums text-orange-300 font-medium">
                    {vb === null ? "—" : metric.format(vb)}
                  </td>
                  <td className={`py-2.5 px-3 text-right tabular-nums font-medium ${deltaClass}`}>
                    {delta === null ? "—" : `${delta > 0 ? "+" : ""}${delta}${metric.unit}`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-[10px] text-slate-600 mt-2">
        Целевые: клиенты «Бух Бератер» с ДЦ/АА-термином в периоде; закрытые, удалённые,
        исключённые из аналитики и A1 не входят. Конверсия считает уникального целевого
        клиента один раз за весь период.
      </p>
    </div>
  );
}

// Общий блок двух графиков. Период здесь СВОЙ, а не «Дата термина» сверху:
// тренировки — активность практики и не зависят от даты термина клиента.
function TrainingChart({ onDrill, vertical }: { onDrill: DrillFn; vertical?: "buh" | "med" | "all" }) {
  const [rangeA, setRangeA] = useState<TrainingRange>(defaultTrainingRange);
  // По умолчанию показываем привычный единый график. Сравнение пользователь
  // включает явно — тогда появляются период B, таблица A/B/Δ и два графика.
  const [compareOn, setCompareOn] = useState(false);
  const [cumulative, setCumulative] = useState(false);
  const [rangeBOverride, setRangeBOverride] = useState<{ sig: string; start: Date; end: Date } | null>(null);
  const [loadedA, setLoadedA] = useState<{ key: string; data: TrainingApiResponse } | null>(null);
  const [loadedB, setLoadedB] = useState<{ key: string; data: TrainingApiResponse } | null>(null);
  const [loadError, setLoadError] = useState<{ key: string; message: string } | null>(null);
  const isMed = vertical === "med";

  const aFrom = fmtLocalDate(rangeA.start);
  const aTo = fmtLocalDate(rangeA.end);
  const windowSig = `${aFrom}|${aTo}`;
  const defaultB = useMemo<TrainingRange>(() => {
    return {
      start: berlinCivilDate(shiftTrainingMonth(aFrom, -1)),
      end: berlinCivilDate(shiftTrainingMonth(aTo, -1)),
    };
  }, [aFrom, aTo]);
  const rangeB = rangeBOverride?.sig === windowSig
    ? { start: rangeBOverride.start, end: rangeBOverride.end }
    : defaultB;
  const bFrom = fmtLocalDate(rangeB.start);
  const bTo = fmtLocalDate(rangeB.end);
  const keyA = `${aFrom}|${aTo}`;
  const keyB = `${bFrom}|${bTo}`;

  useEffect(() => {
    if (isMed) return;
    const ctrl = new AbortController();
    const params = new URLSearchParams({ from: aFrom, to: aTo });
    fetch(`/api/funnel/bot-roleplay-stats?${params}`, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j: TrainingApiResponse) => {
        setLoadedA({ key: keyA, data: j });
        setLoadError((current) => current?.key === keyA ? null : current);
      })
      .catch((e) => {
        if ((e as Error).name !== "AbortError") {
          setLoadError({ key: keyA, message: "Не удалось загрузить период A" });
        }
      });
    return () => ctrl.abort();
  }, [isMed, aFrom, aTo, keyA]);

  useEffect(() => {
    if (isMed || !compareOn) return;
    const ctrl = new AbortController();
    const params = new URLSearchParams({ from: bFrom, to: bTo });
    fetch(`/api/funnel/bot-roleplay-stats?${params}`, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j: TrainingApiResponse) => {
        setLoadedB({ key: keyB, data: j });
        setLoadError((current) => current?.key === keyB ? null : current);
      })
      .catch((e) => {
        if ((e as Error).name !== "AbortError") {
          setLoadError({ key: keyB, message: "Не удалось загрузить период B" });
        }
      });
    return () => ctrl.abort();
  }, [isMed, compareOn, bFrom, bTo, keyB]);

  const dataA = loadedA?.key === keyA ? loadedA.data : null;
  const dataB = compareOn && loadedB?.key === keyB ? loadedB.data : null;
  const rawA = dataA?.points ?? null;
  const rawB = dataB?.points ?? null;
  const periodA = useMemo(
    () => (rawA ? padTrainingDays(aFrom, aTo, rawA) : null),
    [rawA, aFrom, aTo],
  );
  const periodB = useMemo(
    () => (rawB ? padTrainingDays(bFrom, bTo, rawB) : null),
    [rawB, bFrom, bTo],
  );
  const chartData = useMemo(
    () => (periodA && dataA
      ? mergeTrainingPeriods(
          periodA,
          compareOn ? periodB : null,
          cumulative,
        )
      : []),
    [periodA, periodB, dataA, compareOn, cumulative],
  );
  const waiting = rawA === null || (compareOn && rawB === null);
  const error = loadError?.key === keyA || (compareOn && loadError?.key === keyB)
    ? loadError.message
    : null;
  const hasData = chartData.some((p) => (p.totalA ?? 0) > 0 || (p.totalB ?? 0) > 0);

  const openTrainingDay = (point: TrainingChartPoint) => {
    const periods: Array<{ key: "A" | "B"; day: string }> = [];
    if (point.aDate) periods.push({ key: "A", day: point.aDate });
    if (compareOn && point.bDate) periods.push({ key: "B", day: point.bDate });
    Promise.all(
      periods.map(async (period) => {
        const res = await fetch(`/api/funnel/bot-roleplay-day?day=${period.day}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json() as { clients: Array<{ leadId: number; name: string; kommoUrl: string; count: number }> };
        return { period, clients: json.clients ?? [] };
      }),
    )
      .then((groups) => {
        const rows: DrillRow[] = groups.flatMap(({ period, clients }) =>
          clients.map((client) => ({
            key: compareOn ? `${period.key}:${client.leadId}` : client.leadId,
            name: client.name,
            kommoUrl: client.kommoUrl,
            primary: `${compareOn ? `${period.key} · ` : ""}${client.count} рол.`,
          })),
        );
        if (!compareOn && periods[0]) {
          onDrill(`Тренировки ${periods[0].day} — кто сколько прошёл`, rows);
          return;
        }
        const dates = periods.map((p) => `${p.key} ${shortTrainingDate(p.day)}`).join(" · ");
        onDrill(`Тренировки — ${dates}`, rows);
      })
      .catch(() => {});
  };

  return (
    <div className="flex flex-col gap-3">
      {/* Общая панель стоит НАД графиками и управляет сразу обоими. */}
      <div className="glass-panel rounded-2xl border border-white/5 px-4 py-3 flex flex-col gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          <Users className="w-4 h-4 text-blue-400" />
          <span className="text-sm font-medium text-slate-200">Тренировки с ботом по дням</span>
          {!isMed && <span className="text-xs text-slate-500">только завершённые ролевки</span>}
        </div>
        {!isMed && (
          <div className="flex items-center gap-2 flex-wrap justify-start">
            <span className="text-[10px] font-bold text-blue-400">A</span>
            <CalendarPicker
              mode="range"
              value={{ start: rangeA.start, end: rangeA.end } satisfies DateRange}
              onChange={(range) => {
                if (!range.start) return;
                setRangeA({ start: range.start, end: range.end ?? range.start });
              }}
              onClear={() => setRangeA(defaultTrainingRange())}
              maxDate={todayBerlinDate()}
            />
            <button
              type="button"
              onClick={() => setCompareOn((value) => !value)}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-colors ${compareOn ? "bg-orange-500/20 text-orange-400 border-orange-500/30" : "bg-slate-900/60 text-slate-400 border-white/10 hover:text-slate-200"}`}
            >
              <ArrowLeftRight className="w-3.5 h-3.5" />
              Сравнить периоды
            </button>
            {compareOn && (
              <>
                <span className="text-[10px] font-bold text-orange-400">B</span>
                <CalendarPicker
                  mode="range"
                  value={{ start: rangeB.start, end: rangeB.end } satisfies DateRange}
                  onChange={(range) => {
                    if (!range.start) return;
                    setRangeBOverride({ sig: windowSig, start: range.start, end: range.end ?? range.start });
                  }}
                  onClear={() => setRangeBOverride(null)}
                  maxDate={todayBerlinDate()}
                />
              </>
            )}
            <button
              type="button"
              aria-pressed={cumulative}
              onClick={() => setCumulative((value) => !value)}
              className={`px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-colors ${cumulative ? "bg-blue-500/20 text-blue-300 border-blue-500/40" : "bg-slate-900/60 text-slate-400 border-white/10 hover:text-slate-200"}`}
            >
              Кумулятивно
            </button>
            {waiting && <Loader2 className="w-3.5 h-3.5 text-slate-500 animate-spin" />}
          </div>
        )}
      </div>

      {isMed ? (
        <div className="glass-panel rounded-2xl border border-white/5 p-4">
          <MedBotPlaceholder />
        </div>
      ) : error ? (
        <div className="glass-panel rounded-2xl border border-rose-500/30 bg-rose-500/5 px-4 py-3 text-sm text-rose-300 flex items-center gap-2">
          <TriangleAlert className="w-4 h-4 shrink-0" /> {error}
        </div>
      ) : waiting ? (
        <div className="glass-panel rounded-2xl border border-white/5 px-4 py-12 flex items-center justify-center text-sm text-slate-500">
          <Loader2 className="w-4 h-4 animate-spin mr-2" /> загрузка…
        </div>
      ) : (
        <>
          {compareOn && periodA && periodB && dataA && dataB && (
            <TrainingComparisonTable
              pointsA={periodA}
              pointsB={periodB}
              summaryA={dataA.summary}
              summaryB={dataB.summary}
              labelA={trainingRangeLabel(aFrom, aTo)}
              labelB={trainingRangeLabel(bFrom, bTo)}
            />
          )}
          {!hasData ? (
            <div className="glass-panel rounded-2xl border border-white/5 px-4 py-12 text-center text-sm text-slate-500">
              За выбранные периоды завершённых ролевок нет.
            </div>
          ) : !compareOn ? (
            <TrainingCombinedChart
              data={chartData}
              cumulative={cumulative}
              range={trainingRangeLabel(aFrom, aTo)}
              onPointClick={openTrainingDay}
            />
          ) : (
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
              <TrainingMetricChart
                metric="total"
                data={chartData}
                compareOn={compareOn}
                cumulative={cumulative}
                rangeA={trainingRangeLabel(aFrom, aTo)}
                rangeB={compareOn ? trainingRangeLabel(bFrom, bTo) : null}
                onPointClick={openTrainingDay}
              />
              <TrainingMetricChart
                metric="users"
                data={chartData}
                compareOn={compareOn}
                cumulative={cumulative}
                rangeA={trainingRangeLabel(aFrom, aTo)}
                rangeB={compareOn ? trainingRangeLabel(bFrom, bTo) : null}
                onPointClick={openTrainingDay}
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}

// Drill-down: клик по сегменту/столбцу чарта → список клиентов; клик по строке
// открывает карточку клиента (как открывались таблички в berater-dashboard).
function DrillModal({ title, rows, onClose }: { title: string; rows: DrillRow[]; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} aria-hidden="true" />
      <div className="relative w-full max-w-lg max-h-[80vh] bg-slate-900 border border-white/10 rounded-2xl shadow-2xl flex flex-col">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-white/5">
          <span className="text-sm font-medium text-slate-200">{title}</span>
          <span className="text-xs text-slate-500 tabular-nums">{rows.length}</span>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto p-1 rounded-md text-slate-400 hover:text-white hover:bg-white/5"
            aria-label="Закрыть"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="overflow-auto">
          {rows.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-slate-500">нет клиентов</div>
          ) : (
            rows.map((r) => (
              <div
                key={r.key}
                className="flex items-center justify-between gap-3 px-4 py-2 text-sm border-t border-white/5 hover:bg-blue-500/5"
              >
                <a
                  href={r.kommoUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  title="Открыть сделку в Kommo"
                  className="truncate text-blue-300 hover:text-blue-200"
                >
                  {r.name}
                </a>
                <span className="flex items-center gap-3 shrink-0 tabular-nums">
                  <span className="text-slate-300">{r.primary}</span>
                  {r.readiness && (
                    <span className="flex items-center gap-2 cursor-help" title={r.readiness.title}>
                      <span className="font-semibold text-slate-100">{r.readiness.score}</span>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded-md border ${CATEGORY[r.readiness.category].cls}`}>
                        {CATEGORY[r.readiness.category].label}
                      </span>
                    </span>
                  )}
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

// ── Корреляция факторов с Гутшайном ────────────────────────────────────────
// Win-rate (доля Гутшайна среди РЕШЁННЫХ сделок) по сегментам выбранного фактора.
// Самостоятельная панель: свой фетч /api/funnel/correlation, не зависит от
// фильтра термина (как «Тренировки по дням»).

interface CorrSeg { key: string; label: string; decided: number; won: number; winPct: number; small: boolean }
interface CorrTimePoint { date: string; a: number | null; aN: number; b: number | null; bN: number }
interface CorrPayload {
  factor: string; label: string; population: string; caveat: string;
  windowDays?: number;
  segments: CorrSeg[];
  overallPct: number;
  corr: number | null;
  topline: { leftLabel: string; leftPct: number; leftN: number; rightLabel: string; rightPct: number; rightN: number; ratio: number | null } | null;
  series: { key: string; label: string }[];
  points: CorrTimePoint[];
}

// Понедельник недели, к которой относится дата (для группировки «по неделям»).
function mondayOf(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00Z");
  const day = d.getUTCDay(); // 0=вс..6=сб
  const diff = (day === 0 ? -6 : 1) - day;
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

// «По неделям» — НЕ пересредняем (ряд уже скользящее среднее за 30 дн, повторное
// усреднение исказит смысл), берём последнюю точку каждой недели: она уже вобрала
// в себя все дни недели через скользящее окно.
function toWeekly(points: CorrTimePoint[]): CorrTimePoint[] {
  const byWeek = new Map<string, CorrTimePoint>();
  for (const p of points) byWeek.set(mondayOf(p.date), p);
  return Array.from(byWeek.values()).sort((a, b) => (a.date < b.date ? -1 : 1));
}

const CORR_FACTORS: { key: string; label: string }[] = [
  { key: "bot", label: "Ролевки с ботом" },
  { key: "readiness", label: "Уровень готовности" },
  { key: "language", label: "Уровень языка" },
  { key: "okk", label: "Балл ОКК" },
];

// Потолок оси Y: небольшой запас над максимумом (10%), кратно 5. Раньше был
// запас 25% — над линиями оставалась «пустая» четверть графика.
const yMax = (dataMax: number) => Math.max(10, Math.ceil((dataMax * 1.1) / 5) * 5);
const tipStyle = { background: "#0f172a", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, fontSize: 12 } as const;

// Тултип линии по времени: группы отсортированы по убыванию (та, что выше на
// графике в этой точке — выше и в карточке) + цвет совпадает с линией.
function TimeTooltip({ active, payload, label, series }: {
  active?: boolean;
  label?: string;
  payload?: { dataKey?: string | number; value?: number | null; color?: string; payload?: CorrTimePoint }[];
  series: { key: string; label: string }[];
}) {
  if (!active || !payload?.length) return null;
  const items = payload
    .filter((p) => p.value != null)
    .map((p) => ({
      key: String(p.dataKey),
      value: p.value as number,
      color: p.color ?? "#cbd5e1",
      n: (p.payload as Record<string, number> | undefined)?.[`${p.dataKey}N`] ?? 0,
      name: series.find((s) => s.key === p.dataKey)?.label ?? String(p.dataKey),
    }))
    .sort((x, y) => y.value - x.value); // выше значение → выше в карточке
  if (items.length === 0) return null;
  return (
    <div style={{ background: "#0f172a", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, fontSize: 12, padding: "6px 10px" }}>
      <div style={{ color: "#94a3b8", marginBottom: 4 }}>{label}</div>
      {items.map((it) => {
        // n — решённые сделки группы (Гутшайн ИЛИ закрыто) за 30-дневное окно;
        // value% — доля Гутшайна среди них. Восстанавливаем абсолют для ясности.
        const wonN = Math.round((it.value * it.n) / 100);
        return (
          <div key={it.key} style={{ color: it.color, display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ width: 8, height: 8, borderRadius: 99, background: it.color, display: "inline-block" }} />
            {it.name}: <b>{it.value}%</b>
            <span style={{ color: "#64748b" }}>— {wonN} гутшайн. из {it.n} решённых сделок</span>
          </div>
        );
      })}
      <div style={{ color: "#64748b", marginTop: 4, fontSize: 11 }}>
        решённые = Гутшайн или закрыто, за окно 30 дн до этой даты
      </div>
    </div>
  );
}

function CorrelationPanel({
  vertical,
}: {
  vertical?: "buh" | "med" | "all";
}) {
  const [factor, setFactor] = useState<string>("bot");
  const [data, setData] = useState<CorrPayload | null>(null);
  const [granularity, setGranularity] = useState<"day" | "week">("day");

  // Мед + фактор «бот»: у мед будет СВОЙ бот (ещё не подключён) — данные
  // бухового бота не применимы, показываем заглушку и не дёргаем API.
  const medBotStub = vertical === "med" && factor === "bot";

  useEffect(() => {
    if (medBotStub) return;
    let alive = true;
    const err = (caveat: string): CorrPayload =>
      ({ factor, label: "", population: "", caveat, segments: [], overallPct: 0, corr: null, topline: null, series: [], points: [] });
    const vqs = vertical ? `&vertical=${vertical}` : "";
    fetch(`/api/funnel/correlation?factor=${factor}${vqs}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => { if (alive) setData(d?.factor ? (d as CorrPayload) : err("Нет данных")); })
      .catch(() => { if (alive) setData(err("Не удалось загрузить")); });
    return () => { alive = false; };
  }, [factor, vertical, medBotStub]);

  // «Грузится» — данных ещё нет или они под прошлый фактор (без sync setState в эффекте).
  const loading = !medBotStub && (!data || data.factor !== factor);
  const hasSeg = !loading && data!.segments.length > 0;
  // линия по времени осмысленна только если есть хоть одна непустая точка
  const hasTime = !loading && data!.points.some((p) => p.a != null || p.b != null);
  const displayPoints = useMemo(
    () => (!loading && data ? (granularity === "week" ? toWeekly(data.points) : data.points) : []),
    [data, loading, granularity],
  );

  return (
    <div className="glass-panel rounded-2xl border border-white/5 p-4">
      <div className="flex items-center gap-2 flex-wrap">
        <TrendingUp className="w-4 h-4 text-blue-400" />
        <span className="text-sm font-medium text-slate-200">Корреляция с Гутшайном</span>
        {data && !loading && <span className="text-xs text-slate-500">{data.population}</span>}
      </div>

      {/* Переключатель факторов */}
      <div className="inline-flex p-0.5 rounded-lg bg-slate-800/60 border border-white/5 mt-2">
        {CORR_FACTORS.map((f) => (
          <button key={f.key} type="button" onClick={() => setFactor(f.key)}
            className={`text-[11px] px-3 py-1 rounded-md transition-colors ${factor === f.key ? "bg-blue-500/20 text-blue-300" : "text-slate-400 hover:text-white"}`}>
            {f.label}
          </button>
        ))}
      </div>

      {medBotStub && (
        <div className="py-8 flex flex-col items-center justify-center text-center text-xs text-slate-500 gap-1">
          <span>Мед-бот ролевок ещё не подключён.</span>
          <span>Корреляция появится после запуска бота для мед-направления.</span>
        </div>
      )}

      {loading && (
        <div className="py-10 flex justify-center"><Loader2 className="w-5 h-5 animate-spin text-slate-500" /></div>
      )}

      {!medBotStub && !loading && data && (hasSeg || hasTime) && (
        <>
          <div className="mt-3 grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Слева — линия по времени */}
            <div className="flex flex-col">
              <div className="flex items-center justify-between gap-2 mb-1 flex-wrap">
                <span className="text-[10px] uppercase tracking-wider text-slate-500">
                  По дате закрытия · скользящее за {data.windowDays ?? 30} дн
                </span>
                <div className="flex items-center gap-2">
                  <div className="inline-flex p-0.5 rounded-md bg-slate-800/60 border border-white/5">
                    {(["day", "week"] as const).map((g) => (
                      <button key={g} type="button" onClick={() => setGranularity(g)}
                        aria-pressed={granularity === g}
                        className={`text-[10px] px-2 py-0.5 rounded transition-colors ${granularity === g ? "bg-blue-500/20 text-blue-300" : "text-slate-500 hover:text-white"}`}>
                        {g === "day" ? "Дни" : "Недели"}
                      </button>
                    ))}
                  </div>
                  <InfoPopover
                    title="Линия по времени"
                    points={[
                      "Доля Гутшайна среди РЕШЁННЫХ сделок (Гутшайн или закрыто), по дате закрытия, для двух групп.",
                      "Чья линия выше — та группа чаще доводит до Гутшайна. Видно, крепнет ли разрыв со временем.",
                      "Показан общий период — где у ОБЕИХ групп набирается ≥15 сделок в окне; так линии сравнимы и стартуют вместе.",
                      "Зачем скользящее среднее: в день закрывается мало сделок, точечный % скакал бы 0↔100%. Поэтому каждая точка = среднее за 30 дней.",
                      "«Недели» — та же линия, реже точки (конец каждой недели), для читаемости на длинном периоде.",
                      "Это корреляция, не причина (напр. бот выбирают более мотивированные клиенты).",
                    ]}
                  />
                </div>
              </div>
              {hasTime ? (
                <div className="h-52">
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={displayPoints} margin={{ top: 8, right: 12, bottom: 0, left: -14 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                      <XAxis dataKey="date" tick={{ fontSize: 10, fill: "#94a3b8" }} minTickGap={36}
                        tickFormatter={(d: string) => (typeof d === "string" ? d.slice(5) : d)} />
                      <YAxis tick={{ fontSize: 11, fill: "#94a3b8" }} unit="%"
                        domain={[0, yMax(Math.max(1, ...displayPoints.flatMap((p) => [p.a ?? 0, p.b ?? 0])))]} />
                      <Tooltip content={<TimeTooltip series={data.series} />} />
                      <Line type="monotone" dataKey="a" name={data.series[0]?.label} stroke="#34d399" strokeWidth={2.5} dot={false} connectNulls isAnimationActive={false} />
                      <Line type="monotone" dataKey="b" name={data.series[1]?.label} stroke="#94a3b8" strokeWidth={2.5} dot={false} connectNulls isAnimationActive={false} />
                      <Legend wrapperStyle={{ fontSize: 11, color: "#cbd5e1" }} />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <div className="h-52 flex items-center justify-center text-xs text-slate-500">мало данных для линии по времени</div>
              )}
            </div>

            {/* Справа — столбики по сегментам */}
            <div className="flex flex-col">
              <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1">По сегментам (win-rate)</div>
              {hasSeg ? (
                <div className="h-52">
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={data.segments} margin={{ top: 18, right: 12, bottom: 0, left: -14 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" vertical={false} />
                      <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#94a3b8" }} />
                      <YAxis tick={{ fontSize: 11, fill: "#94a3b8" }} unit="%"
                        domain={[0, yMax(Math.max(...data.segments.map((s) => s.winPct)))]} />
                      <Tooltip cursor={{ fill: "rgba(255,255,255,0.04)" }} contentStyle={tipStyle} itemStyle={{ color: "#e2e8f0" }} labelStyle={{ color: "#94a3b8" }}
                        formatter={(v, _n, p) => {
                          const seg = p?.payload as CorrSeg;
                          return [`${v}% · ${seg.won}/${seg.decided}${seg.small ? " ⚠ мало" : ""}`, "win-rate"];
                        }} />
                      {data.overallPct != null && (
                        <ReferenceLine y={data.overallPct} stroke="#64748b" strokeDasharray="4 4"
                          label={{ value: `ср. ${data.overallPct}%`, fill: "#94a3b8", fontSize: 10, position: "insideTopRight" }} />
                      )}
                      <Bar dataKey="winPct" radius={[4, 4, 0, 0]} isAnimationActive={false}>
                        {data.segments.map((s) => (
                          <Cell key={s.key} fill={s.small ? "#334155" : "#60a5fa"} />
                        ))}
                        <LabelList dataKey="winPct" position="top" formatter={(v) => `${v}%`} fontSize={11} fill="#cbd5e1" />
                      </Bar>
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <div className="h-52 flex items-center justify-center text-xs text-slate-500">нет данных по сегментам</div>
              )}
              {data.topline?.ratio && (
                <div className="text-[11px] text-slate-400 mt-1">
                  «{data.topline.leftLabel}» — Гутшайн в <b className="text-emerald-300">{data.topline.ratio}×</b> чаще, чем «{data.topline.rightLabel}»
                </div>
              )}
            </div>
          </div>

          <div className="text-[11px] text-slate-500 leading-relaxed mt-2">
            {data.corr != null && <>Связь ≈ <b className="text-slate-300">{data.corr}</b> (−1…1). </>}{data.caveat}
          </div>
        </>
      )}

      {!medBotStub && !loading && data && !hasSeg && !hasTime && (
        <div className="py-6 text-center text-xs text-slate-500">{data.caveat || "Нет данных"}</div>
      )}
    </div>
  );
}

/** Баллы ролевок (5-балльная шкала), в порядке отображения распределения. */
const READINESS_BINS = [5, 4, 3, 2, 1] as const;

/** Дельта среднего со стрелкой (зелёная рост / красная падение). */
function AvgDelta({ delta }: { delta: number }) {
  return (
    <span
      className={`text-xs font-bold tabular-nums ${
        delta > 0 ? "text-emerald-400" : delta < 0 ? "text-rose-400" : "text-slate-400"
      }`}
    >
      {delta > 0 ? "▲" : delta < 0 ? "▼" : "="}
      {Math.abs(delta)}
    </span>
  );
}

/** Одна сторона (ДЦ или АА): среднее + компактная гистограмма с наложением
 *  периода сравнения (тонкая «призрачная» полоса = было). */
function ReadinessMetric({
  label,
  side,
  compareSide,
}: {
  label: string;
  side: SideReadinessSummary;
  /** Сторона периода сравнения; undefined = сравнение выключено. */
  compareSide: SideReadinessSummary | undefined;
}) {
  const cmp = compareSide;
  const delta =
    cmp && side.avg != null && cmp.avg != null
      ? Math.round((side.avg - cmp.avg) * 10) / 10
      : null;
  const maxBin = Math.max(
    1,
    ...READINESS_BINS.map((b) => Math.max(side.dist[String(b)] ?? 0, cmp?.dist[String(b)] ?? 0)),
  );
  return (
    <div className="flex-1 min-w-[240px] flex flex-col gap-2">
      <div className="flex items-baseline gap-2">
        <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">{label}</span>
        <span className="text-3xl font-black text-white tabular-nums leading-none">
          {side.avg ?? "—"}
        </span>
        {cmp && (
          <span className="text-sm text-slate-500 tabular-nums">
            <span className="text-slate-600">←</span> {cmp.avg ?? "—"}
          </span>
        )}
        {delta != null && <AvgDelta delta={delta} />}
        <span className="ml-auto text-[10px] text-slate-500 tabular-nums self-center">
          {side.scored} оц. · {side.none} без
        </span>
      </div>
      <div className="flex flex-col gap-1">
        {READINESS_BINS.map((b) => {
          const n = side.dist[String(b)] ?? 0;
          const cn = cmp?.dist[String(b)] ?? 0;
          return (
            <div key={b} className="flex items-center gap-2">
              <span className="w-2.5 text-[11px] font-semibold tabular-nums text-slate-500 text-right">
                {b}
              </span>
              <div className="flex-1 h-2.5 rounded-full bg-slate-800/60 relative overflow-hidden">
                {cmp && (
                  <div
                    className="absolute inset-y-0 left-0 rounded-full bg-slate-500/40"
                    style={{ width: `${(cn / maxBin) * 100}%` }}
                  />
                )}
                <div
                  className="absolute inset-y-0 left-0 rounded-full bg-sky-400 transition-[width] duration-300"
                  style={{ width: `${(n / maxBin) * 100}%` }}
                />
              </div>
              <span className="w-12 text-right text-[11px] tabular-nums text-slate-300">
                {n}
                {cmp && <span className="text-slate-600"> ({cn})</span>}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Виджет «Готовность к терминам» с распределением баллов и сравнением периодов. */
function ReadinessSummaryWidget({
  summary,
  compareSummary,
  compareTermin,
  onCompareChange,
  compareLoading,
}: {
  summary: ClientsReadinessSummary;
  compareSummary: ClientsReadinessSummary | null;
  compareTermin: { start: Date | null; end: Date | null } | null;
  onCompareChange: (r: { start: Date | null; end: Date | null } | null) => void;
  compareLoading: boolean;
}) {
  const cmpActive = compareTermin != null;
  return (
    <div className="bg-slate-900/40 rounded-2xl border border-white/5 px-4 py-3 flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <span className="text-[10px] uppercase tracking-widest font-semibold text-slate-500">
          Готовность к терминам (среднее за период)
        </span>
        <div className="flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-widest font-semibold text-slate-500">
            Сравнить с
          </span>
          <CalendarPicker
            mode="range"
            value={compareTermin ?? { start: null, end: null }}
            onChange={onCompareChange}
            onClear={() => onCompareChange(null)}
          />
          {compareLoading && <Loader2 className="w-3.5 h-3.5 text-slate-500 animate-spin" />}
        </div>
      </div>
      <div className="flex gap-8 flex-wrap">
        <ReadinessMetric
          label="ДЦ"
          side={summary.dc}
          compareSide={cmpActive ? compareSummary?.dc : undefined}
        />
        <ReadinessMetric
          label="АА"
          side={summary.aa}
          compareSide={cmpActive ? compareSummary?.aa : undefined}
        />
      </div>
    </div>
  );
}

export default function ClientsView({ filters: _filters, vertical, limited = false }: Props) {
  const [data, setData] = useState<ClientsResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ClientRow | null>(null);
  const [drill, setDrill] = useState<{ title: string; rows: DrillRow[] } | null>(null);
  // Клиентский фильтр по ответственному менеджеру ("" = все). Влияет и на чарты, и на таблицы.
  const [manager, setManager] = useState("");
  // Клиентский фильтр по этапу ("" = все) — запрошен со звонка 2026-07-13,
  // вместе с менеджером это единственные два доп. фильтра, которые нужны.
  const [stage, setStage] = useState("");
  // Собственный фильтр вкладки — по дате термина. По умолчанию сегодня (1 день),
  // но можно выбрать период.
  const [termin, setTermin] = useState<{ start: Date | null; end: Date | null }>(
    () => {
      const t = todayBerlinDate();
      return { start: t, end: t };
    }
  );
  // Период сравнения для виджета готовности (null = сравнение выключено).
  const [compareTermin, setCompareTermin] = useState<{ start: Date | null; end: Date | null } | null>(null);
  const [compareData, setCompareData] = useState<ClientsResult | null>(null);
  const [compareLoading, setCompareLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // Набор для графиков/метрик: клиенты, чей термин попал в выбранный диапазон дат
  // (актуальность задаётся самим фильтром даты). Won-бэклог без термина в диапазоне
  // в графики не идёт — он остаётся в таблице «Гутшайн одобрен».
  // Менеджеры для дропдауна — distinct из загруженных клиентов (active+won), отсортированы.
  const managerOptions = useMemo(() => {
    if (!data) return [];
    const names = new Set<string>();
    for (const c of [...data.active.clients, ...data.won.clients]) {
      if (c.managerName) names.add(c.managerName);
    }
    return Array.from(names)
      .sort((a, b) => a.localeCompare(b, "ru"))
      .map((n) => ({ value: n, label: n }));
  }, [data]);

  // Этапы для дропдауна — distinct из загруженных клиентов (active+won).
  const stageOptions = useMemo(() => {
    if (!data) return [];
    const names = new Set<string>();
    for (const c of [...data.active.clients, ...data.won.clients]) {
      if (c.status) names.add(c.status);
    }
    return Array.from(names)
      .sort((a, b) => a.localeCompare(b, "ru"))
      .map((n) => ({ value: n, label: n }));
  }, [data]);

  const chartClients = useMemo(() => {
    if (!data) return [];
    return [...data.active.clients, ...data.won.clients].filter(
      (c) =>
        c.terminInRange &&
        (manager === "" || c.managerName === manager) &&
        (stage === "" || c.status === stage),
    );
  }, [data, manager, stage]);
  const uniqueBotUsers = useMemo(
    () => chartClients.filter((c) => c.botRoleplayCount > 0).length,
    [chartClients],
  );
  // Выбранные менеджер/этап пропали из новых данных (смена периода) → сброс на
  // «Все», чтобы дропдаун и фильтр не рассинхронились (render-time паттерн, без
  // setState-в-эффекте).
  if (manager !== "" && data !== null && !managerOptions.some((o) => o.value === manager)) {
    setManager("");
  }
  if (stage !== "" && data !== null && !stageOptions.some((o) => o.value === stage)) {
    setStage("");
  }

  const start = termin.start ?? todayBerlinDate();
  // Одна дата (нет end или end == start) = «с этого числа и дальше» (>=);
  // две разные даты = период.
  const hasRange =
    termin.start != null &&
    termin.end != null &&
    termin.end.getTime() !== termin.start.getTime();
  const terminFrom = fmtLocalDate(start);
  const terminTo = hasRange ? fmtLocalDate(termin.end as Date) : null;
  const lang = _filters.lang;
  const key = `${terminFrom}|${terminTo ?? "open"}|${lang}|${vertical ?? "-"}`;

  const load = useCallback(
    async (k: string, tFrom: string, tTo: string | null, langBucket: string) => {
    const cached = cache.get(k);
    if (cached) {
      setData(cached);
      setError(null);
      return; // мгновенно из кеша, без спиннера
    }
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ termin_from: tFrom, limit: String(FETCH_LIMIT) });
      if (tTo) params.set("termin_to", tTo);
      if (langBucket) params.set("lang", langBucket);
      if (vertical) params.set("vertical", vertical);
      const res = await fetch(`/api/funnel/clients?${params}`, { signal: ctrl.signal });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${await res.text().catch(() => "")}`);
      }
      const json: ClientsResult = await res.json();
      cache.set(k, json);
      setData(json);
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (abortRef.current === ctrl) {
        abortRef.current = null;
        setLoading(false);
      }
    }
  }, [vertical]);

  useEffect(() => {
    const id = setTimeout(() => load(key, terminFrom, terminTo, lang), 250);
    return () => clearTimeout(id);
  }, [key, terminFrom, terminTo, lang, load]);

  // Период сравнения → отдельный запрос (тот же endpoint + общий кеш).
  const cmpStart = compareTermin?.start ?? null;
  const cmpHasRange =
    compareTermin?.start != null &&
    compareTermin?.end != null &&
    compareTermin.end.getTime() !== compareTermin.start.getTime();
  const compareFrom = cmpStart ? fmtLocalDate(cmpStart) : null;
  const compareTo = cmpHasRange ? fmtLocalDate(compareTermin!.end as Date) : null;
  const compareKey = compareFrom
    ? `${compareFrom}|${compareTo ?? "open"}|${lang}|${vertical ?? "-"}`
    : null;

  useEffect(() => {
    if (!compareFrom || !compareKey) {
      setCompareData(null);
      return;
    }
    const cached = cache.get(compareKey);
    if (cached) {
      setCompareData(cached);
      return;
    }
    const ctrl = new AbortController();
    setCompareLoading(true);
    const params = new URLSearchParams({ termin_from: compareFrom, limit: String(FETCH_LIMIT) });
    if (compareTo) params.set("termin_to", compareTo);
    if (lang) params.set("lang", lang);
    if (vertical) params.set("vertical", vertical);
    fetch(`/api/funnel/clients?${params}`, { signal: ctrl.signal })
      .then((r) => (r.ok ? (r.json() as Promise<ClientsResult>) : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j) => {
        cache.set(compareKey, j);
        setCompareData(j);
      })
      .catch((e) => {
        if ((e as Error).name !== "AbortError") setCompareData(null);
      })
      .finally(() => setCompareLoading(false));
    return () => ctrl.abort();
  }, [compareKey, compareFrom, compareTo, lang, vertical]);

  const isEmpty =
    data && data.active.shown === 0 && data.won.shown === 0;

  return (
    <div className="flex flex-col gap-4">
      {/* Sticky — запрос со звонка 2026-07-13: плашки фильтров должны оставаться
          сверху окна при скролле длинных таблиц ниже, а не «уезжать» вверх страницы. */}
      <div className="bg-slate-900 shadow-lg sticky top-0 z-20 rounded-2xl border border-white/5 px-4 py-3 flex items-center gap-3 flex-wrap">
        <span className="text-[10px] uppercase tracking-widest font-semibold text-slate-500">
          Дата термина
        </span>
        <CalendarPicker
          mode="range"
          value={termin}
          onChange={setTermin}
          onClear={() => {
            const t = todayBerlinDate();
            setTermin({ start: t, end: t });
          }}
        />
        <span className="text-[10px] uppercase tracking-widest font-semibold text-slate-500">
          Менеджер
        </span>
        <FilterSelect
          value={manager}
          options={managerOptions}
          onChange={setManager}
          emptyLabel="Все"
          ariaLabel="Фильтр по менеджеру"
          minWidthClass="min-w-[160px]"
        />
        <span className="text-[10px] uppercase tracking-widest font-semibold text-slate-500">
          Этап
        </span>
        <FilterSelect
          value={stage}
          options={stageOptions}
          onChange={setStage}
          emptyLabel="Все"
          ariaLabel="Фильтр по этапу"
          minWidthClass="min-w-[160px]"
        />
        {loading && <Loader2 className="w-3.5 h-3.5 text-slate-500 animate-spin" />}
        <span className="text-[11px] text-slate-500 ml-auto">
          одна дата — термины с этого числа и дальше; период — диапазон
        </span>
      </div>

      {loading && !data && (
        <div className="glass-panel rounded-2xl border border-white/5 px-4 py-12 flex items-center justify-center gap-2 text-sm text-slate-400">
          <Loader2 className="w-4 h-4 animate-spin" /> Загрузка клиентов…
        </div>
      )}

      {error && (
        <div className="glass-panel rounded-2xl border border-rose-500/30 bg-rose-500/5 px-4 py-3 text-sm text-rose-300 flex items-center gap-2">
          <TriangleAlert className="w-4 h-4 shrink-0" />
          <span className="truncate">Не удалось загрузить клиентов: {error}</span>
        </div>
      )}

      {isEmpty && (
        <div className="glass-panel rounded-2xl border border-white/5 px-4 py-12 text-center text-sm text-slate-500">
          Нет клиентов с термином на выбранную дату/период.
        </div>
      )}

      {data && (
        <>
          <div className="glass-panel rounded-2xl border border-white/5 px-4 py-2.5 flex items-center gap-5 text-xs text-slate-400 flex-wrap">
            <span>
              В выборке: <b className="text-slate-200 tabular-nums">{chartClients.length}</b>
            </span>
            <span>
              Прошли ролевки с ботом:{" "}
              <b className="text-slate-200 tabular-nums">{vertical === "med" ? "—" : uniqueBotUsers}</b>
              {vertical === "med" ? " (мед-бот не подключён)" : " уник."}
            </span>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <RoleplayDistribution clients={chartClients} onDrill={(title, rows) => setDrill({ title, rows })} vertical={vertical} />
            <LanguageLevels clients={chartClients} onDrill={(title, rows) => setDrill({ title, rows })} />
          </div>
          {/* Тренировки не привязаны к дате термина и используют свой период. */}
          <TrainingChart onDrill={(title, rows) => setDrill({ title, rows })} vertical={vertical} />
          {!limited && (
            <>
              <CorrelationPanel vertical={vertical} />
              <ReadinessSummaryWidget
                summary={data.summary}
                compareSummary={compareData?.summary ?? null}
                compareTermin={compareTermin}
                onCompareChange={setCompareTermin}
                compareLoading={compareLoading}
              />
              <ClientTable
                group={filterGroup(data.active, manager, stage)}
                title="Клиенты в работе"
                icon={<Users className="w-4 h-4 text-blue-400" />}
                onRowClick={setSelected}
                onFilterManager={setManager}
                onFilterStage={setStage}
              />
              <ClientTable
                group={filterGroup(data.won, manager, stage)}
                title="Гутшайн одобрен"
                icon={<Trophy className="w-4 h-4 text-emerald-400" />}
                onRowClick={setSelected}
                onFilterManager={setManager}
                onFilterStage={setStage}
              />
            </>
          )}
        </>
      )}

      {drill && <DrillModal title={drill.title} rows={drill.rows} onClose={() => setDrill(null)} />}
      {!limited && selected && <ClientDrawer client={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}
