"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Users, Loader2, TriangleAlert, ArrowUp, ArrowDown, Trophy, ChartPie, Languages, X } from "lucide-react";
import { PieChart, Pie, Cell, Tooltip, Legend, ResponsiveContainer, BarChart, Bar, XAxis, YAxis, ComposedChart, Area, Line } from "recharts";
import { fmtLocalDate, todayBerlinDate } from "@/lib/utils/date";
import CalendarPicker from "@/components/CalendarPicker";
import type { FunnelFiltersState } from "@/lib/funnel/types";
import type {
  ClientRow,
  ClientsResult,
  ClientGroup,
  ClientSideReadiness,
} from "@/lib/funnel/clients";
import type { BotDailyPoint } from "@/lib/funnel/bot-roleplays";
import ClientDrawer from "@/components/funnel/ClientDrawer";
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
}

const CATEGORY = {
  hot: { label: "Hot", cls: "text-emerald-300 bg-emerald-500/10 border-emerald-500/30" },
  warm: { label: "Warm", cls: "text-amber-300 bg-amber-500/10 border-amber-500/30" },
  cold: { label: "Cold", cls: "text-slate-400 bg-slate-500/10 border-slate-500/20" },
} as const;

const LANG_LABEL: Record<ClientRow["languageBucket"], string> = {
  a2: "A2",
  b1: "B1",
  b2: "B2",
  c1: "C1",
  unknown: "—",
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
  unknown: 0,
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
  if (side.attempts.length === 0) return <span className="text-slate-600">—</span>;
  const last = side.attempts[side.attempts.length - 1];
  return (
    <span className="inline-flex items-center gap-1 tabular-nums">
      <span className={`font-semibold ${scoreColor(last)}`}>{last}</span>
      {side.attempts.length > 1 && (
        <span className="text-[10px] text-slate-500">[{side.attempts.join("→")}]</span>
      )}
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
  | "consultations"
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
  { key: "consultations", label: "Конс.", align: "center", value: (c) => c.consultations },
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

// Клиентский фильтр группы по менеджеру (данные уже загружены целиком, ~250 строк).
// manager === "" → без фильтра. Пересчитываем total/shown/categories под отфильтрованных.
function filterGroupByManager(group: ClientGroup, manager: string): ClientGroup {
  if (!manager) return group;
  const clients = group.clients.filter((c) => c.managerName === manager);
  return { clients, total: clients.length, shown: clients.length, categories: countCats(clients) };
}

function ClientTable({
  group,
  title,
  icon,
  onRowClick,
}: {
  group: ClientGroup;
  title: string;
  icon: ReactNode;
  onRowClick: (c: ClientRow) => void;
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
                  <td className="px-3 py-2 text-slate-400 max-w-[190px] truncate">{c.status ?? "—"}</td>
                  <td className="px-3 py-2 text-slate-400 max-w-[150px] truncate">{c.managerName ?? "—"}</td>
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
                  <td className="px-3 py-2 text-center text-slate-300 tabular-nums">
                    {c.consultations || <span className="text-slate-600">—</span>}
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
const RP_BUCKETS: { key: string; label: string; min: number; max: number; color: string }[] = [
  { key: "0", label: "0 ролевок", min: 0, max: 0, color: "#64748b" },
  { key: "1-2", label: "1–2", min: 1, max: 2, color: "#f0b63d" },
  { key: "3-4", label: "3–4", min: 3, max: 4, color: "#8fbe91" },
  { key: "5+", label: "5+", min: 5, max: Number.POSITIVE_INFINITY, color: "#18a98b" },
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

function RoleplayDistribution({ clients, onDrill }: { clients: ClientRow[]; onDrill: DrillFn }) {
  const all = clients;
  const dist = useMemo(
    () =>
      RP_BUCKETS.map((b) => ({
        label: b.label,
        color: b.color,
        min: b.min,
        max: b.max,
        value: all.filter((c) => c.botRoleplayCount >= b.min && c.botRoleplayCount <= b.max).length,
      })),
    [all],
  );
  const total = dist.reduce((s, d) => s + d.value, 0);
  if (total === 0) return null;

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
                const e = (d?.payload?.payload ?? d?.payload ?? d) as { label?: string; min?: number; max?: number };
                const min = e.min ?? 0;
                const max = e.max ?? Number.POSITIVE_INFINITY;
                const rows = all
                  .filter((c) => c.botRoleplayCount >= min && c.botRoleplayCount <= max)
                  .sort((a, b) => b.botRoleplayCount - a.botRoleplayCount)
                  .map(clientToDrillRow);
                onDrill(`Тренировок с ботом: ${e.label ?? ""}`, rows);
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

const LANG_ORDER: ClientRow["languageBucket"][] = ["a2", "b1", "b2", "c1", "unknown"];

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

// Всплывающая табличка дня: всего ролевок (+ разбивка по уровням) и уникальных.
function TrainingTooltip({ active, payload, label }: {
  active?: boolean;
  payload?: Array<{ payload: BotDailyPoint }>;
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div style={{ background: "#0f172a", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, fontSize: 12, padding: "6px 10px" }}>
      <div style={{ color: "#94a3b8", marginBottom: 2 }}>{label}</div>
      <div style={{ color: "#e2e8f0" }}>
        Ролевок: <b>{p.total}</b> <span style={{ color: "#64748b" }}>(Ур.1 {p.lvl1} · Ур.2 {p.lvl2})</span>
      </div>
      <div style={{ color: "#e2e8f0" }}>
        Уникальных: <b>{p.users}</b>
      </div>
    </div>
  );
}

// Тренировки с ботом по дням за последние 8 недель (независимо от фильтра термина —
// это активность практики, а не сделки). Сам грузит свой endpoint. Клик по дню →
// список «кто сколько прошёл» в этот день.
function TrainingChart({ onDrill }: { onDrill: DrillFn }) {
  const [points, setPoints] = useState<BotDailyPoint[] | null>(null);

  const onDayClick = (s: { activeLabel?: string | number }) => {
    const day = s?.activeLabel != null ? String(s.activeLabel) : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return;
    fetch(`/api/funnel/bot-roleplay-day?day=${day}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j: { clients: Array<{ leadId: number; name: string; kommoUrl: string; count: number }> }) => {
        const rows: DrillRow[] = (j.clients ?? []).map((c) => ({
          key: c.leadId,
          name: c.name,
          kommoUrl: c.kommoUrl,
          primary: `${c.count} рол.`,
        }));
        onDrill(`Тренировки ${day} — кто сколько прошёл`, rows);
      })
      .catch(() => {});
  };
  useEffect(() => {
    let cancelled = false;
    const to = todayBerlinDate();
    const from = new Date(to);
    from.setDate(from.getDate() - 56);
    const params = new URLSearchParams({ from: fmtLocalDate(from), to: fmtLocalDate(to) });
    fetch(`/api/funnel/bot-roleplay-stats?${params}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j: { points: BotDailyPoint[] }) => {
        if (!cancelled) setPoints(j.points ?? []);
      })
      .catch(() => {
        if (!cancelled) setPoints([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (points !== null && points.length === 0) return null; // нет данных бота / env off
  return (
    <div className="glass-panel rounded-2xl border border-white/5 p-4">
      <div className="flex items-center gap-2 mb-1">
        <Users className="w-4 h-4 text-blue-400" />
        <span className="text-sm font-medium text-slate-200">Тренировки с ботом по дням</span>
        <span className="text-xs text-slate-500">8 недель · клик по дню — кто тренировался</span>
      </div>
      <div className="h-56">
        {points === null ? (
          <div className="flex items-center justify-center h-full text-sm text-slate-500">
            <Loader2 className="w-4 h-4 animate-spin mr-2" /> загрузка…
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: -20 }} onClick={onDayClick} className="cursor-pointer">
              <XAxis dataKey="day" tickFormatter={(d: string) => d.slice(5)} tick={{ fill: "#94a3b8", fontSize: 11 }} axisLine={false} tickLine={false} minTickGap={24} />
              <YAxis allowDecimals={false} tick={{ fill: "#94a3b8", fontSize: 12 }} axisLine={false} tickLine={false} />
              <Tooltip content={<TrainingTooltip />} />
              <Legend wrapperStyle={{ fontSize: 12, color: "#cbd5e1" }} />
              {/* Область = всего ролевок за день; линия = уникальные пользователи.
                  Разбивка по уровням — в тултипе, чтобы не перегружать визуал. */}
              <Area type="monotone" dataKey="total" stroke="#60a5fa" fill="rgba(96,165,250,0.28)" name="Ролевок" />
              <Line type="monotone" dataKey="users" stroke="#f0b63d" strokeWidth={2} dot={false} name="Уникальных" />
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </div>
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

export default function ClientsView({ filters: _filters }: Props) {
  const [data, setData] = useState<ClientsResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ClientRow | null>(null);
  const [drill, setDrill] = useState<{ title: string; rows: DrillRow[] } | null>(null);
  // Клиентский фильтр по ответственному менеджеру ("" = все). Влияет и на чарты, и на таблицы.
  const [manager, setManager] = useState("");
  // Собственный фильтр вкладки — по дате термина. По умолчанию сегодня (1 день),
  // но можно выбрать период.
  const [termin, setTermin] = useState<{ start: Date | null; end: Date | null }>(
    () => {
      const t = todayBerlinDate();
      return { start: t, end: t };
    }
  );
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

  const chartClients = useMemo(() => {
    if (!data) return [];
    return [...data.active.clients, ...data.won.clients].filter(
      (c) => c.terminInRange && (manager === "" || c.managerName === manager),
    );
  }, [data, manager]);
  const uniqueBotUsers = useMemo(
    () => chartClients.filter((c) => c.botRoleplayCount > 0).length,
    [chartClients],
  );
  // Выбранный менеджер пропал из новых данных (смена периода) → сброс на «Все», чтобы
  // дропдаун и фильтр не рассинхронились (render-time паттерн, без setState-в-эффекте).
  if (manager !== "" && data !== null && !managerOptions.some((o) => o.value === manager)) {
    setManager("");
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
  const key = `${terminFrom}|${terminTo ?? "open"}|${lang}`;

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
  }, []);

  useEffect(() => {
    const id = setTimeout(() => load(key, terminFrom, terminTo, lang), 250);
    return () => clearTimeout(id);
  }, [key, terminFrom, terminTo, lang, load]);

  const isEmpty =
    data && data.active.shown === 0 && data.won.shown === 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="glass-panel rounded-2xl border border-white/5 px-4 py-3 flex items-center gap-3 flex-wrap">
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
              Прошли ролевки с ботом: <b className="text-slate-200 tabular-nums">{uniqueBotUsers}</b> уник.
            </span>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <RoleplayDistribution clients={chartClients} onDrill={(title, rows) => setDrill({ title, rows })} />
            <LanguageLevels clients={chartClients} onDrill={(title, rows) => setDrill({ title, rows })} />
          </div>
          <TrainingChart onDrill={(title, rows) => setDrill({ title, rows })} />
          <ClientTable
            group={filterGroupByManager(data.active, manager)}
            title="Клиенты в работе"
            icon={<Users className="w-4 h-4 text-blue-400" />}
            onRowClick={setSelected}
          />
          <ClientTable
            group={filterGroupByManager(data.won, manager)}
            title="Гутшайн одобрен"
            icon={<Trophy className="w-4 h-4 text-emerald-400" />}
            onRowClick={setSelected}
          />
        </>
      )}

      {drill && <DrillModal title={drill.title} rows={drill.rows} onClose={() => setDrill(null)} />}
      {selected && <ClientDrawer client={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}
