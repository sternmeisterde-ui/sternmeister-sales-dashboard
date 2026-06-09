"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Users, Loader2, TriangleAlert, ArrowUp, ArrowDown } from "lucide-react";
import { fmtLocalDate } from "@/lib/utils/date";
import type { FunnelFiltersState } from "@/lib/funnel/types";
import type { ManagerRoleKey, ManagerRow, ManagersResult } from "@/lib/funnel/managers";

// Фон-сюрфейс табов = фон таблицы (бесшовный стык, как в «Аналитике»).
const TAB_SURFACE = "rgb(15, 23, 42)";

// Кеш по периоду+источнику — все роли в одном ответе, переключение мгновенно.
const cache = new Map<string, ManagersResult>();

interface Props {
  filters: FunnelFiltersState;
}

const ROLES: { key: ManagerRoleKey; label: string; hint: string }[] = [
  { key: "qualifier", label: "Квалификатор", hint: "ответственный Гос-сделки (линия 1)" },
  { key: "berater", label: "Бератер", hint: "ответственный Бератер-сделки (линия 2)" },
  { key: "dovedenie", label: "Доведение", hint: "ответственный Бератер-сделки (линия 3)" },
];

type SortKey =
  | "name"
  | "clients"
  | "reachedDocs"
  | "reachedTermDc"
  | "reachedGutschein"
  | "conversionC5Pct"
  | "consultations"
  | "touches"
  | "avgOkk";

interface Column {
  key: SortKey;
  label: string;
  title: string;
  numeric: boolean;
}

const COLUMNS: Column[] = [
  { key: "name", label: "Менеджер", title: "Менеджер в выбранной роли", numeric: false },
  { key: "clients", label: "Клиенты", title: "Активных клиентов (без дисквала)", numeric: true },
  { key: "reachedDocs", label: "→ Док", title: "Доведено до «Документы в ДЦ»", numeric: true },
  { key: "reachedTermDc", label: "→ Термин ДЦ", title: "Доведено до «Термин ДЦ»", numeric: true },
  { key: "reachedGutschein", label: "→ Гутшайн", title: "Доведено до «Гутшайн» (сквозь Бератер)", numeric: true },
  { key: "conversionC5Pct", label: "C5 %", title: "Личная сквозная конверсия: Гутшайн / Клиенты", numeric: true },
  { key: "consultations", label: "Конс.", title: "Проведённых консультаций (ДЦ+АА) по клиентам", numeric: true },
  { key: "touches", label: "Касания", title: "Касаний по клиентам менеджера за выбранный период", numeric: true },
  { key: "avgOkk", label: "ОКК", title: "Средний ОКК звонков роли (0–100)", numeric: true },
];

export default function ManagersView({ filters }: Props) {
  const [data, setData] = useState<ManagersResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [role, setRole] = useState<ManagerRoleKey>("qualifier");
  const [sortKey, setSortKey] = useState<SortKey>("clients");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const abortRef = useRef<AbortController | null>(null);

  const cacheKey = useMemo(() => {
    const from = filters.dateRange.start ? fmtLocalDate(filters.dateRange.start) : "";
    const to = filters.dateRange.end ? fmtLocalDate(filters.dateRange.end) : "";
    return `${from}|${to}|${filters.source}`;
  }, [filters.dateRange.start, filters.dateRange.end, filters.source]);

  const load = useCallback(async () => {
    if (!filters.dateRange.start || !filters.dateRange.end) return;
    const cached = cache.get(cacheKey);
    if (cached) {
      setData(cached);
      return;
    }
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        from: fmtLocalDate(filters.dateRange.start),
        to: fmtLocalDate(filters.dateRange.end),
      });
      if (filters.source) params.set("source", filters.source);
      const res = await fetch(`/api/funnel/managers?${params}`, { signal: ctrl.signal });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${await res.text().catch(() => "")}`);
      }
      const payload: ManagersResult = await res.json();
      cache.set(cacheKey, payload);
      setData(payload);
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [cacheKey, filters.dateRange.start, filters.dateRange.end, filters.source]);

  useEffect(() => {
    load();
  }, [load]);

  const rows = useMemo(() => {
    const src = data?.roles[role] ?? [];
    const sorted = [...src];
    const dir = sortDir === "asc" ? 1 : -1;
    sorted.sort((a, b) => {
      if (sortKey === "name") return dir * a.name.localeCompare(b.name, "ru");
      const av = valueOf(a, sortKey);
      const bv = valueOf(b, sortKey);
      if (av === null && bv === null) return 0;
      if (av === null) return 1; // null всегда вниз
      if (bv === null) return -1;
      return dir * (av - bv);
    });
    return sorted;
  }, [data, role, sortKey, sortDir]);

  const onSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "name" ? "asc" : "desc");
    }
  };

  const activeRole = ROLES.find((r) => r.key === role)!;

  return (
    <div className="glass-panel rounded-2xl border border-white/5 p-4">
      <div className="flex items-center gap-2 mb-1">
        <Users className="w-4 h-4 text-blue-400" />
        <h3 className="text-sm font-semibold text-white">Срез по менеджерам</h3>
        {loading && <Loader2 className="w-3.5 h-3.5 text-slate-500 animate-spin" />}
      </div>
      <p className="text-[11px] text-slate-500 mb-3">
        {activeRole.label}: {activeRole.hint}. Дисквалы и РОП исключены. ОКК —
        средний балл звонков роли (есть с апреля 2026).
      </p>

      {error && (
        <div className="rounded-xl border border-rose-500/30 bg-rose-500/5 px-3 py-2 text-xs text-rose-300 flex items-center gap-2 mb-3">
          <TriangleAlert className="w-3.5 h-3.5 shrink-0" />
          <span className="truncate">Не удалось загрузить: {error}</span>
        </div>
      )}

      {/* Папка-табы ролей (стиль вкладок «Аналитики»). */}
      <div className="flex items-end gap-1 pl-1" style={{ marginBottom: -1 }}>
        {ROLES.map((r) => {
          const sel = role === r.key;
          const count = data?.roles[r.key]?.length ?? null;
          return (
            <button
              key={r.key}
              type="button"
              onClick={() => setRole(r.key)}
              aria-pressed={sel}
              className={`relative px-4 pt-1.5 pb-2.5 text-[10px] uppercase tracking-widest font-bold transition-colors focus:outline-none ${
                sel ? "text-blue-400" : "text-slate-400 hover:text-white"
              }`}
            >
              <span
                aria-hidden
                className={`absolute inset-0 rounded-t-xl border-t border-x ${
                  sel ? "border-white/10" : "border-white/5"
                }`}
                style={{ background: sel ? TAB_SURFACE : "rgba(30, 41, 59, 0.4)" }}
              />
              <span className="relative">
                {r.label}
                {count !== null && <span className="ml-1.5 opacity-60">{count}</span>}
              </span>
            </button>
          );
        })}
      </div>

      <div
        className="overflow-x-auto max-h-[460px] overflow-y-auto rounded-b-xl rounded-tr-xl border border-white/10"
        style={{ background: TAB_SURFACE }}
      >
        {rows.length === 0 ? (
          <div className="text-xs text-slate-500 py-8 text-center">
            {loading ? "Загрузка…" : "Нет менеджеров в этой роли за выбранный период."}
          </div>
        ) : (
          <table className="w-full text-xs">
            <thead className="sticky top-0 z-10" style={{ background: TAB_SURFACE }}>
              <tr className="text-slate-400 border-b border-white/10">
                {COLUMNS.map((col) => (
                  <th
                    key={col.key}
                    title={col.title}
                    onClick={() => onSort(col.key)}
                    className={`px-3 py-2 font-medium cursor-pointer select-none hover:text-white whitespace-nowrap ${
                      col.numeric ? "text-right" : "text-left"
                    }`}
                  >
                    <span className="inline-flex items-center gap-1">
                      {col.numeric && sortKey === col.key && <SortIcon dir={sortDir} />}
                      {col.label}
                      {!col.numeric && sortKey === col.key && <SortIcon dir={sortDir} />}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.userId ?? r.name} className="border-t border-white/5 hover:bg-white/[0.03]">
                  <td className="px-3 py-2 text-left whitespace-nowrap">
                    <span className="text-slate-200">{r.name}</span>
                    {r.line && (
                      <span className="ml-2 text-[10px] text-slate-500 px-1.5 py-0.5 rounded bg-slate-800/60 border border-white/5">
                        Л{r.line}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right text-slate-200 tabular-nums">{r.clients}</td>
                  <td className="px-3 py-2 text-right text-slate-300 tabular-nums">{r.reachedDocs}</td>
                  <td className="px-3 py-2 text-right text-slate-300 tabular-nums">{r.reachedTermDc}</td>
                  <td className="px-3 py-2 text-right text-emerald-300 tabular-nums">{r.reachedGutschein}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtPct(r.conversionC5Pct)}</td>
                  <td className="px-3 py-2 text-right text-slate-300 tabular-nums">{r.consultations}</td>
                  <td className="px-3 py-2 text-right text-slate-400 tabular-nums">{r.touches}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtOkk(r.avgOkk, r.okkScored)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function valueOf(r: ManagerRow, key: SortKey): number | null {
  switch (key) {
    case "clients": return r.clients;
    case "reachedDocs": return r.reachedDocs;
    case "reachedTermDc": return r.reachedTermDc;
    case "reachedGutschein": return r.reachedGutschein;
    case "conversionC5Pct": return r.conversionC5Pct;
    case "consultations": return r.consultations;
    case "touches": return r.touches;
    case "avgOkk": return r.avgOkk;
    default: return null;
  }
}

function fmtPct(v: number | null): React.ReactNode {
  if (v === null) return <span className="text-slate-600">—</span>;
  const cls = v >= 4 ? "text-emerald-300" : v >= 2 ? "text-amber-300" : "text-slate-400";
  return <span className={cls}>{v.toFixed(1)}%</span>;
}

function fmtOkk(v: number | null, n: number): React.ReactNode {
  if (v === null) return <span className="text-slate-600">—</span>;
  const cls = v >= 80 ? "text-emerald-300" : v >= 60 ? "text-amber-300" : "text-rose-300";
  return (
    <span title={`${n} оценённых звонков`} className={cls}>
      {v}
    </span>
  );
}

function SortIcon({ dir }: { dir: "asc" | "desc" }) {
  return dir === "asc" ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />;
}
