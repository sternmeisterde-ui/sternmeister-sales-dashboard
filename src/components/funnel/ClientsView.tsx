"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Users, Loader2, TriangleAlert, ArrowUp, ArrowDown, Trophy } from "lucide-react";
import { fmtLocalDate, todayBerlinDate } from "@/lib/utils/date";
import CalendarPicker from "@/components/CalendarPicker";
import type { FunnelFiltersState } from "@/lib/funnel/types";
import type {
  ClientRow,
  ClientsResult,
  ClientGroup,
  ClientSideReadiness,
} from "@/lib/funnel/clients";
import ClientDrawer from "@/components/funnel/ClientDrawer";

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
  | "termin"
  | "language"
  | "dc"
  | "aa"
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
  { key: "termin", label: "Термин", align: "center", value: (c) => (c.terminAtIso ? Date.parse(c.terminAtIso) : Number.POSITIVE_INFINITY) },
  { key: "language", label: "Язык", align: "center", value: (c) => LANG_RANK[c.languageBucket] },
  { key: "dc", label: "ДЦ", align: "center", value: (c) => c.dc.latest ?? -1 },
  { key: "aa", label: "АА", align: "center", value: (c) => c.aa.latest ?? -1 },
  { key: "activity", label: "Активность", align: "right", value: (c) => c.daysSinceLastTouch ?? Number.POSITIVE_INFINITY },
  { key: "score", label: "Готовность", align: "right", value: (c) => c.score },
];

function compare(a: number | string, b: number | string): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), "ru");
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
                  <td className="px-3 py-2 text-center text-slate-300 tabular-nums">{fmtTermin(c.terminAtIso)}</td>
                  <td className="px-3 py-2 text-center text-slate-300">{LANG_LABEL[c.languageBucket]}</td>
                  <td className="px-3 py-2 text-center"><SideCell side={c.dc} /></td>
                  <td className="px-3 py-2 text-center"><SideCell side={c.aa} /></td>
                  <td className="px-3 py-2 text-right text-slate-400 tabular-nums">
                    {c.daysSinceLastTouch === null
                      ? "—"
                      : c.daysSinceLastTouch === 0
                        ? "сегодня"
                        : `${c.daysSinceLastTouch}д`}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <span className="inline-flex items-center gap-2">
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

export default function ClientsView({ filters: _filters }: Props) {
  const [data, setData] = useState<ClientsResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ClientRow | null>(null);
  // Собственный фильтр вкладки — по дате термина. По умолчанию сегодня (1 день),
  // но можно выбрать период.
  const [termin, setTermin] = useState<{ start: Date | null; end: Date | null }>(
    () => {
      const t = todayBerlinDate();
      return { start: t, end: t };
    }
  );
  const abortRef = useRef<AbortController | null>(null);

  const start = termin.start ?? todayBerlinDate();
  // Одна дата (нет end или end == start) = «с этого числа и дальше» (>=);
  // две разные даты = период.
  const hasRange =
    termin.start != null &&
    termin.end != null &&
    termin.end.getTime() !== termin.start.getTime();
  const terminFrom = fmtLocalDate(start);
  const terminTo = hasRange ? fmtLocalDate(termin.end as Date) : null;
  const key = `${terminFrom}|${terminTo ?? "open"}`;

  const load = useCallback(async (k: string, tFrom: string, tTo: string | null) => {
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
    const id = setTimeout(() => load(key, terminFrom, terminTo), 250);
    return () => clearTimeout(id);
  }, [key, terminFrom, terminTo, load]);

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
          <ClientTable
            group={data.active}
            title="Клиенты в работе"
            icon={<Users className="w-4 h-4 text-blue-400" />}
            onRowClick={setSelected}
          />
          <ClientTable
            group={data.won}
            title="Гутшайн одобрен"
            icon={<Trophy className="w-4 h-4 text-emerald-400" />}
            onRowClick={setSelected}
          />
        </>
      )}

      {selected && <ClientDrawer client={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}
