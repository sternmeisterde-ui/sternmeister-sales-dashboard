"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Loader2,
  TriangleAlert,
  ClipboardCheck,
  ExternalLink,
  Info,
} from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  LabelList,
  ResponsiveContainer,
} from "recharts";
import CalendarPicker from "@/components/CalendarPicker";
import FilterSelect from "@/components/funnel/FilterSelect";
import RoleplayDetailDrawer from "@/components/funnel/RoleplayDetailDrawer";
import { fmtLocalDate, todayBerlinDate } from "@/lib/utils/date";
import type { RoleplaysResult, ClientRow, ManagerRow } from "@/lib/funnel/roleplays-section";

/**
 * Раздел «Ролевки». Период фильтруется по ДАТЕ КОНСУЛЬТАЦИИ (когда звонили), а
 * не по дате термина — вопрос раздела «сколько провели за неделю», и ответ
 * должен меняться вместе с выбранными неделями.
 *
 * Палитра серий проверена валидатором (dataviz, dark, surface #0f172a):
 * lightness band / chroma / CVD (worst ΔE 12.5 protan) / контраст — всё PASS.
 */
const C_CONSULT = "#3b82f6"; // консультации — полное покрытие
const C_ANALYZED = "#d97706"; // разобрано ОКК
const C_CONFIRMED = "#0d9488"; // ролевка подтверждена

const PAGE_SIZE = 50;
const cache = new Map<string, RoleplaysResult>();

interface Props {
  vertical?: "buh" | "med" | "all";
}

function fmtDay(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", timeZone: "Europe/Berlin" });
}

function weekLabel(ymd: string): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  return d.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", timeZone: "UTC" });
}

function scoreColor(s: number): string {
  if (s >= 4) return "text-emerald-300";
  if (s === 3) return "text-amber-300";
  return "text-rose-300";
}

const tipStyle = {
  background: "#0f172a",
  border: "1px solid rgba(255,255,255,0.1)",
  borderRadius: 12,
  fontSize: 12,
} as const;

export default function RoleplaysView({ vertical }: Props) {
  const today = todayBerlinDate();
  const monthStart = new Date(today);
  monthStart.setDate(1);

  const [range, setRange] = useState<{ start: Date | null; end: Date | null }>({
    start: monthStart,
    end: today,
  });
  const [manager, setManager] = useState("");
  const [data, setData] = useState<RoleplaysResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [visible, setVisible] = useState(PAGE_SIZE);
  const [selected, setSelected] = useState<ClientRow | null>(null);

  const from = fmtLocalDate(range.start ?? monthStart);
  const to = fmtLocalDate(range.end ?? range.start ?? today);
  const key = `${from}|${to}|${vertical ?? "-"}`;

  useEffect(() => {
    const ctrl = new AbortController();
    const id = setTimeout(() => {
      const cached = cache.get(key);
      if (cached) {
        setData(cached);
        setError(null);
        return;
      }
      setLoading(true);
      setError(null);
      const params = new URLSearchParams({ from, to });
      if (vertical) params.set("vertical", vertical);
      fetch(`/api/funnel/roleplays-section?${params}`, { signal: ctrl.signal })
        .then((r) => (r.ok ? (r.json() as Promise<RoleplaysResult>) : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((j) => {
          cache.set(key, j);
          setData(j);
        })
        .catch((e) => {
          if ((e as Error).name !== "AbortError") setError(e instanceof Error ? e.message : String(e));
        })
        .finally(() => setLoading(false));
    }, 250);
    return () => {
      clearTimeout(id);
      ctrl.abort();
    };
  }, [key, from, to, vertical]);

  const managerOptions = useMemo(
    () => (data?.managers ?? []).map((m) => ({ value: m.name, label: m.name })),
    [data],
  );

  const clients = useMemo(() => {
    if (!data) return [];
    return manager ? data.clients.filter((c) => c.managerName === manager) : data.clients;
  }, [data, manager]);

  const [seen, setSeen] = useState(clients);
  if (seen !== clients) {
    setSeen(clients);
    setVisible(PAGE_SIZE);
  }

  const weeks = data?.weeks ?? [];
  const chartData = weeks.map((w) => ({
    label: weekLabel(w.weekStart),
    Консультации: w.consultations,
    "Разобрано ОКК": w.analyzed,
    "Ролевка подтверждена": w.confirmed,
    perLead: w.perLead ?? 0,
  }));

  return (
    <div className="flex flex-col gap-4">
      <div className="bg-slate-900 shadow-lg sticky top-0 z-20 rounded-2xl border border-white/5 px-4 py-3 flex items-center gap-3 flex-wrap">
        <span className="text-[10px] uppercase tracking-widest font-semibold text-slate-500">
          Период консультаций
        </span>
        <CalendarPicker
          mode="range"
          value={range}
          onChange={setRange}
          onClear={() => setRange({ start: monthStart, end: today })}
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
          фильтр по дате звонка, а не термина
        </span>
      </div>

      {error && (
        <div className="glass-panel rounded-2xl border border-rose-500/30 bg-rose-500/5 px-4 py-3 text-sm text-rose-300 flex items-center gap-2">
          <TriangleAlert className="w-4 h-4 shrink-0" />
          <span className="truncate">Не удалось загрузить раздел: {error}</span>
        </div>
      )}

      {!data && loading && (
        <div className="glass-panel rounded-2xl border border-white/5 px-4 py-12 flex items-center justify-center gap-2 text-sm text-slate-400">
          <Loader2 className="w-4 h-4 animate-spin" /> Загрузка…
        </div>
      )}

      {data && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
            <Tile
              label="Консультаций"
              value={data.totals.consultations}
              hint="Соединённые звонки от 10 минут, сделанные пока сделка стояла на этапе консультации перед ДЦ или АА. Полное покрытие — считается по телефонии, а не по ОКК."
            />
            <Tile
              label="Разобрано ОКК"
              value={data.totals.analyzed}
              sub={data.coveragePct === null ? undefined : `${data.coveragePct}% консультаций`}
              hint="ОКК берёт в разбор только звонки от 15 минут, поэтому часть консультаций в него не попадает. Непокрытое ≠ «ролевки не было»."
            />
            <Tile
              label="Ролевка подтверждена"
              value={data.totals.confirmed}
              sub={
                data.totals.analyzed > 0
                  ? `${Math.round((data.totals.confirmed / data.totals.analyzed) * 100)}% разобранных`
                  : undefined
              }
              hint="Из разобранных: клиент реально сам отвечал по-немецки. Менеджерский критерий мягче — он засчитывает и «предложил / перенёс / отправил в тренажёр», поэтому здесь не используется."
            />
            <Tile label="Клиентов" value={data.totals.leads} hint="Уникальных сделок с консультациями за период." />
            <Tile
              label="Консультаций на клиента"
              value={data.totals.perLead ?? 0}
              hint="Ключевая метрика роста: чем больше повторных консультаций на одного клиента, тем выше конверсия в Гутшайн."
            />
          </div>

          <div className="glass-panel rounded-2xl border border-white/5 p-4">
            <div className="flex items-center gap-2 mb-3">
              <ClipboardCheck className="w-4 h-4 text-blue-400" />
              <span className="text-sm font-medium text-slate-200">Понедельно</span>
              <span className="text-xs text-slate-500">недели по понедельникам, Берлин</span>
            </div>
            <div className="h-[260px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} margin={{ top: 16, right: 8, bottom: 0, left: -18 }} barGap={2}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#94a3b8" }} tickLine={false} />
                  <YAxis tick={{ fontSize: 11, fill: "#94a3b8" }} tickLine={false} axisLine={false} />
                  <Tooltip cursor={{ fill: "rgba(255,255,255,0.04)" }} contentStyle={tipStyle} itemStyle={{ color: "#e2e8f0" }} labelStyle={{ color: "#94a3b8" }} />
                  <Legend wrapperStyle={{ fontSize: 11, color: "#94a3b8" }} />
                  <Bar dataKey="Консультации" fill={C_CONSULT} radius={[4, 4, 0, 0]} isAnimationActive={false} />
                  <Bar dataKey="Разобрано ОКК" fill={C_ANALYZED} radius={[4, 4, 0, 0]} isAnimationActive={false} />
                  <Bar dataKey="Ролевка подтверждена" fill={C_CONFIRMED} radius={[4, 4, 0, 0]} isAnimationActive={false} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Отдельный график: у «на клиента» своя шкала, а две оси на одном
              графике — запрещённый приём (нечитаемо и вводит в заблуждение). */}
          <div className="glass-panel rounded-2xl border border-white/5 p-4">
            <div className="flex items-center gap-2 mb-3">
              <span className="text-sm font-medium text-slate-200">Консультаций на клиента</span>
              <span className="text-xs text-slate-500">цель — больше двух</span>
            </div>
            <div className="h-[160px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} margin={{ top: 18, right: 8, bottom: 0, left: -18 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#94a3b8" }} tickLine={false} />
                  <YAxis tick={{ fontSize: 11, fill: "#94a3b8" }} tickLine={false} axisLine={false} />
                  <Tooltip cursor={{ fill: "rgba(255,255,255,0.04)" }} contentStyle={tipStyle} itemStyle={{ color: "#e2e8f0" }} labelStyle={{ color: "#94a3b8" }} />
                  <Bar dataKey="perLead" name="на клиента" fill={C_CONSULT} radius={[4, 4, 0, 0]} isAnimationActive={false}>
                    <LabelList dataKey="perLead" position="top" style={{ fill: "#94a3b8", fontSize: 11 }} />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          <ManagersTable rows={data.managers} onPick={setManager} picked={manager} />

          <ClientsTable
            rows={clients.slice(0, visible)}
            total={clients.length}
            onMore={() => setVisible((v) => v + PAGE_SIZE)}
            onPick={setSelected}
          />

          <div className="glass-panel rounded-2xl border border-white/5 px-4 py-3 text-[11px] text-slate-500 flex gap-2">
            <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span>
              Оценки в карточке Kommo заполняют два источника: менеджер руками и — с 22.06.2026 —
              сам бот ОКК (он записывает свой балл автоматически и может перезаписать ручной).
              Колонка «руками» показывает только правки людей: они видны по событиям Kommo,
              записи бота в этот журнал не попадают.
            </span>
          </div>
        </>
      )}

      {selected && (
        <RoleplayDetailDrawer
          leadId={selected.leadId}
          name={selected.name}
          managerName={selected.managerName}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

function Tile({
  label,
  value,
  sub,
  hint,
}: {
  label: string;
  value: number;
  sub?: string;
  hint: string;
}) {
  return (
    <div className="glass-panel rounded-2xl border border-white/5 px-4 py-3 cursor-help" title={hint}>
      <div className="text-[10px] uppercase tracking-widest text-slate-500">{label}</div>
      <div className="text-2xl font-semibold text-slate-100 tabular-nums mt-0.5">{value}</div>
      {sub && <div className="text-[11px] text-slate-500">{sub}</div>}
    </div>
  );
}

function ManagersTable({
  rows,
  onPick,
  picked,
}: {
  rows: ManagerRow[];
  onPick: (name: string) => void;
  picked: string;
}) {
  if (rows.length === 0) return null;
  return (
    <div className="glass-panel rounded-2xl border border-white/5 overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-white/5">
        <span className="text-sm font-medium text-slate-200">По менеджерам</span>
        <span className="text-xs text-slate-500">клик по строке — отфильтровать клиентов</span>
      </div>
      <div className="overflow-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[10px] uppercase tracking-widest font-semibold text-slate-500">
              <th className="px-3 py-2 text-left">Менеджер</th>
              <th className="px-3 py-2 text-right">Консультаций</th>
              <th className="px-3 py-2 text-right">Клиентов</th>
              <th className="px-3 py-2 text-right">На клиента</th>
              <th className="px-3 py-2 text-right">Разобрано</th>
              <th className="px-3 py-2 text-right">Подтверждено</th>
              <th className="px-3 py-2 text-right" title="Оценок, выставленных руками в карточке Kommo">
                Оценок руками
              </th>
              <th className="px-3 py-2 text-right" title="Оценок, посчитанных ботом (с 22.06 он их и записывает в Kommo)">
                Оценок ботом
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => (
              <tr
                key={m.name}
                onClick={() => onPick(picked === m.name ? "" : m.name)}
                className={`border-t border-white/5 cursor-pointer hover:bg-blue-500/5 ${
                  picked === m.name ? "bg-blue-500/10" : ""
                }`}
              >
                <td className="px-3 py-2 text-slate-200">{m.name}</td>
                <td className="px-3 py-2 text-right text-slate-100 tabular-nums font-semibold">{m.consultations}</td>
                <td className="px-3 py-2 text-right text-slate-400 tabular-nums">{m.leads}</td>
                <td className="px-3 py-2 text-right text-slate-300 tabular-nums">{m.perLead ?? "—"}</td>
                <td className="px-3 py-2 text-right text-slate-400 tabular-nums">{m.analyzed}</td>
                <td className="px-3 py-2 text-right text-slate-300 tabular-nums">{m.confirmed}</td>
                <td className="px-3 py-2 text-right text-slate-400 tabular-nums">{m.manualScores}</td>
                <td className="px-3 py-2 text-right text-slate-400 tabular-nums">{m.botScores}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ClientsTable({
  rows,
  total,
  onMore,
  onPick,
}: {
  rows: ClientRow[];
  total: number;
  onMore: () => void;
  onPick: (c: ClientRow) => void;
}) {
  if (total === 0) return null;
  return (
    <div className="glass-panel rounded-2xl border border-white/5 overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-white/5">
        <span className="text-sm font-medium text-slate-200">По клиентам</span>
        <span className="text-xs text-slate-500 tabular-nums">
          показано {rows.length} из {total}
        </span>
        <span className="text-xs text-slate-500 ml-auto">клик по строке — разбор ролевок</span>
      </div>
      <div className="overflow-auto max-h-[520px]">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-slate-900/80 backdrop-blur z-10">
            <tr className="text-[10px] uppercase tracking-widest font-semibold text-slate-500">
              <th className="px-3 py-2 text-left">Клиент</th>
              <th className="px-3 py-2 text-left">Менеджер</th>
              <th className="px-3 py-2 text-left">Этап консультации</th>
              <th className="px-3 py-2 text-center">Термин</th>
              <th className="px-3 py-2 text-right">Конс.</th>
              <th className="px-3 py-2 text-right">Разобрано</th>
              <th className="px-3 py-2 text-center">Оценки бота</th>
              <th className="px-3 py-2 text-center">Проставлено руками</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr
                key={c.leadId}
                tabIndex={0}
                onClick={() => onPick(c)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onPick(c);
                  }
                }}
                className="border-t border-white/5 hover:bg-blue-500/5 focus:bg-blue-500/10 cursor-pointer outline-none"
              >
                <td className="px-3 py-2 max-w-[190px] truncate">
                  <a
                    href={`https://sternmeister.kommo.com/leads/detail/${c.leadId}`}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    className="text-slate-200 hover:text-blue-300 inline-flex items-center gap-1"
                  >
                    {c.name}
                    <ExternalLink className="w-3 h-3 opacity-50 shrink-0" />
                  </a>
                </td>
                <td className="px-3 py-2 text-slate-300 max-w-[150px] truncate">{c.managerName ?? "—"}</td>
                <td className="px-3 py-2 text-slate-400 max-w-[190px] truncate">{c.stage ?? "—"}</td>
                <td className="px-3 py-2 text-center text-slate-300 tabular-nums">{fmtDay(c.terminIso)}</td>
                <td className="px-3 py-2 text-right text-slate-100 tabular-nums font-semibold">{c.consultations}</td>
                <td className="px-3 py-2 text-right text-slate-400 tabular-nums">
                  {c.analyzed}
                  {c.analyzed < c.consultations && (
                    <span
                      className="text-slate-600"
                      title={`ОКК не разобрал ${c.consultations - c.analyzed} консультаций — короче 15 минут`}
                    >
                      {" "}
                      /{c.consultations}
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 text-center">
                  {c.botScores.length === 0 ? (
                    <span className="text-slate-600">—</span>
                  ) : (
                    <span className="inline-flex items-center gap-1 tabular-nums">
                      {c.botScores.map((b, i) => (
                        <span key={i} className="inline-flex items-center gap-1">
                          {i > 0 && <span className="text-slate-600">→</span>}
                          {b.score !== null ? (
                            <span className={`font-semibold ${scoreColor(b.score)}`}>{b.score}</span>
                          ) : b.notScored === "degenerate" ? (
                            <span className="text-amber-500" title="Ролевка была, но авто-оценка сорвалась">⚠</span>
                          ) : (
                            <span className="text-slate-500" title="Ролевка была, но клиент дал слишком мало самостоятельных немецких ответов">○</span>
                          )}
                        </span>
                      ))}
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 text-center">
                  {c.manualEdits.length === 0 ? (
                    <span className="text-slate-600">—</span>
                  ) : (
                    <span
                      className="text-slate-300 tabular-nums cursor-help"
                      title={c.manualEdits
                        .map(
                          (e) =>
                            `${e.side === "dc" ? "ДЦ" : "АА"}-${e.attempt} = ${e.score ?? "?"} · ${fmtDay(e.at)} · ${e.author ?? "неизвестно"}`,
                        )
                        .join("\n")}
                    >
                      {c.manualEdits.length}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length < total && (
        <div className="px-4 py-2.5 border-t border-white/5 flex justify-center">
          <button
            type="button"
            onClick={onMore}
            className="text-xs text-slate-400 hover:text-white px-3 py-1 rounded-md hover:bg-white/5"
          >
            Показать ещё
          </button>
        </div>
      )}
    </div>
  );
}
