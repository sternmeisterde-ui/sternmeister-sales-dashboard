"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip as RTooltip,
  XAxis,
  YAxis,
} from "recharts";
import { HeartPulse, Loader2, RefreshCw, X } from "lucide-react";
import DinoLoader from "@/components/DinoLoader";
import { addDaysCivil, fmtLocalDate, todayBerlinDate } from "@/lib/utils/date";

// Форма ответа /api/enps (зеркалит src/lib/enps/stats.ts).
interface WeekPoint {
  weekStart: string;
  count: number;
  avg: number;
  promoters: number;
  passives: number;
  detractors: number;
  enps: number;
}
interface ResponseItem {
  submittedAt: string;
  weekStart: string;
  score: number;
  supports: string | null;
  frustrates: string | null;
}
interface EnpsStats {
  available: boolean;
  syncConfigured: boolean;
  range: { from: string | null; to: string | null };
  totals: {
    count: number;
    avg: number | null;
    enps: number | null;
    promoters: number;
    passives: number;
    detractors: number;
  };
  weeks: WeekPoint[];
  distribution: { score: number; count: number }[];
  responses: ResponseItem[];
  lastSubmittedAt: string | null;
  lastSyncedAt: string | null;
}

// Пресеты периода. Формы заполняются ~раз в неделю, календарь с точностью до
// дня здесь избыточен — три пресета покрывают все реальные вопросы.
type RangePreset = "12w" | "26w" | "all";
const PRESETS: ReadonlyArray<{ id: RangePreset; label: string }> = [
  { id: "12w", label: "12 недель" },
  { id: "26w", label: "26 недель" },
  { id: "all", label: "Всё время" },
];

function presetFrom(preset: RangePreset): string | null {
  if (preset === "all") return null;
  const weeks = preset === "12w" ? 12 : 26;
  return addDaysCivil(fmtLocalDate(todayBerlinDate()), -7 * weeks);
}

/** "YYYY-MM-DD" → "DD.MM" без таймзонных сюрпризов (чистая строка). */
function fmtWeek(weekStart: string): string {
  return `${weekStart.slice(8, 10)}.${weekStart.slice(5, 7)}`;
}

function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    timeZone: "Europe/Berlin",
  });
}

function scoreBadgeClass(score: number): string {
  if (score >= 9) return "bg-emerald-500/20 text-emerald-300";
  if (score >= 7) return "bg-amber-500/20 text-amber-300";
  return "bg-red-500/20 text-red-300";
}

function enpsColor(enps: number | null): string {
  if (enps === null) return "text-slate-400";
  if (enps >= 30) return "text-emerald-300";
  if (enps >= 0) return "text-amber-300";
  return "text-red-300";
}

const TOOLTIP_STYLE = {
  background: "#0f172a",
  border: "1px solid rgba(255,255,255,0.1)",
  borderRadius: 8,
  fontSize: 12,
} as const;

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export default function EnpsTab({ department: _department }: { department: "b2g" | "b2b" }) {
  const [stats, setStats] = useState<EnpsStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [preset, setPreset] = useState<RangePreset>("all");
  const [selectedWeek, setSelectedWeek] = useState<string | null>(null);

  const load = useCallback(async (p: RangePreset) => {
    setLoading(true);
    setError(null);
    setSelectedWeek(null);
    try {
      const params = new URLSearchParams();
      const from = presetFrom(p);
      if (from) params.set("from", from);
      const qs = params.toString();
      const res = await fetch(`/api/enps${qs ? `?${qs}` : ""}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setStats((await res.json()) as EnpsStats);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(preset);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onPreset = (p: RangePreset) => {
    setPreset(p);
    load(p);
  };

  // Данные stacked-графика структуры: доли в процентах, чтобы недели с разным
  // числом ответов были сравнимы (абсолюты видно в тултипе и на графике динамики).
  const structureData = useMemo(
    () =>
      (stats?.weeks ?? []).map((w) => ({
        ...w,
        promotersPct: w.count ? Math.round((w.promoters / w.count) * 100) : 0,
        passivesPct: w.count ? Math.round((w.passives / w.count) * 100) : 0,
        detractorsPct: w.count ? Math.round((w.detractors / w.count) * 100) : 0,
      })),
    [stats],
  );

  const lastWeek = stats?.weeks.length ? stats.weeks[stats.weeks.length - 1] : null;

  const quotes = useMemo(() => {
    const all = stats?.responses ?? [];
    return selectedWeek ? all.filter((r) => r.weekStart === selectedWeek) : all;
  }, [stats, selectedWeek]);

  const supportsQuotes = useMemo(
    () => quotes.filter((r) => r.supports && r.supports.length > 1),
    [quotes],
  );
  const frustratesQuotes = useMemo(
    () => quotes.filter((r) => r.frustrates && r.frustrates.length > 1),
    [quotes],
  );

  if (loading && !stats) {
    return (
      <div className="flex items-center justify-center py-24">
        <DinoLoader />
      </div>
    );
  }

  const unavailable = !stats || !stats.available;

  return (
    <div className="flex flex-col gap-6 fade-in">
      {/* Заголовок + период + обновить */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2 text-slate-200">
          <HeartPulse className="w-5 h-5 text-blue-400" />
          <span className="text-base font-semibold">eNPS</span>
        </div>

        <div className="flex rounded-lg border border-white/10 bg-slate-900/60 p-0.5">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              onClick={() => onPreset(p.id)}
              className={`rounded-md px-3 py-1 text-xs transition-colors ${
                preset === p.id
                  ? "bg-blue-500/20 text-blue-300"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>

        {stats && !stats.syncConfigured && (
          <span className="text-[11px] text-amber-300/80">
            автосинк из Google Sheets не настроен — данные из последнего импорта
          </span>
        )}

        <button
          onClick={() => load(preset)}
          disabled={loading}
          className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-slate-900/60 px-3 py-1.5 text-xs text-slate-300 hover:border-white/20 disabled:opacity-50"
        >
          {loading ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <RefreshCw className="w-3.5 h-3.5" />
          )}
          Обновить
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          Не удалось загрузить eNPS: {error}
        </div>
      )}

      {unavailable && !error && (
        <div className="rounded-lg border border-white/10 bg-slate-900/60 px-4 py-8 text-center text-sm text-slate-400">
          Ответов за период нет.
          <div className="mt-1 text-xs text-slate-500">
            Опрос анонимный: менеджеры заполняют Typeform, данные приходят через Google Sheets.
          </div>
        </div>
      )}

      {stats && !unavailable && (
        <>
          {/* KPI: анонимные агрегаты периода. 9–10 промоутеры / 7–8 нейтралы /
              0–6 критики; eNPS = %промоутеров − %критиков. */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-lg border border-white/10 bg-slate-900/40 p-4">
              <div className="text-xs uppercase tracking-wider text-slate-500">eNPS за период</div>
              <div className={`mt-1 text-2xl font-semibold ${enpsColor(stats.totals.enps)}`}>
                {stats.totals.enps === null ? "—" : stats.totals.enps > 0 ? `+${stats.totals.enps}` : stats.totals.enps}
              </div>
              <div className="mt-1 text-[11px] text-slate-500">
                промоутеры {stats.totals.count ? Math.round((stats.totals.promoters / stats.totals.count) * 100) : 0}% ·
                критики {stats.totals.count ? Math.round((stats.totals.detractors / stats.totals.count) * 100) : 0}%
              </div>
            </div>
            <div className="rounded-lg border border-white/10 bg-slate-900/40 p-4">
              <div className="text-xs uppercase tracking-wider text-slate-500">Средний балл</div>
              <div className="mt-1 text-2xl font-semibold text-slate-100">
                {stats.totals.avg === null ? "—" : stats.totals.avg.toFixed(1)}
                <span className="text-sm text-slate-500"> / 10</span>
              </div>
              <div className="mt-1 text-[11px] text-slate-500">эмоциональное состояние</div>
            </div>
            <div className="rounded-lg border border-white/10 bg-slate-900/40 p-4">
              <div className="text-xs uppercase tracking-wider text-slate-500">Ответов за период</div>
              <div className="mt-1 text-2xl font-semibold text-slate-100">{stats.totals.count}</div>
              <div className="mt-1 text-[11px] text-slate-500">
                последний: {stats.lastSubmittedAt ? fmtDateTime(stats.lastSubmittedAt) : "—"}
              </div>
            </div>
            <div className="rounded-lg border border-white/10 bg-slate-900/40 p-4">
              <div className="text-xs uppercase tracking-wider text-slate-500">Последняя неделя</div>
              <div className="mt-1 text-2xl font-semibold text-slate-100">
                {lastWeek ? lastWeek.avg.toFixed(1) : "—"}
                <span className="text-sm text-slate-500"> / 10</span>
              </div>
              <div className="mt-1 text-[11px] text-slate-500">
                {lastWeek ? `неделя с ${fmtWeek(lastWeek.weekStart)} · ${lastWeek.count} отв.` : "нет данных"}
              </div>
            </div>
          </div>

          {/* Динамика по неделям: средний балл + число ответов. Мало ответов в
              неделе → балл скачет, поэтому объём всегда рядом с линией. */}
          <section>
            <div className="mb-2 flex items-baseline justify-between gap-2">
              <h3 className="text-xs uppercase tracking-wider text-slate-500">
                Динамика по неделям
              </h3>
              <span className="text-[11px] text-blue-300/80">
                нажмите на неделю, чтобы отфильтровать ответы ниже
              </span>
            </div>
            <div className="rounded-lg border border-white/10 bg-slate-900/40 p-3" style={{ cursor: "pointer" }}>
              <ResponsiveContainer width="100%" height={240}>
                <ComposedChart
                  data={stats.weeks}
                  margin={{ top: 8, right: 0, bottom: 0, left: -16 }}
                  onClick={(state) => {
                    const lbl = (state as { activeLabel?: string | number } | null)?.activeLabel;
                    if (lbl != null) setSelectedWeek(String(lbl));
                  }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                  <XAxis
                    dataKey="weekStart"
                    tickFormatter={fmtWeek}
                    tick={{ fill: "#94a3b8", fontSize: 11 }}
                    axisLine={{ stroke: "rgba(255,255,255,0.1)" }}
                    tickLine={false}
                    minTickGap={24}
                  />
                  <YAxis
                    yAxisId="avg"
                    domain={[0, 10]}
                    tick={{ fill: "#94a3b8", fontSize: 11 }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis yAxisId="count" orientation="right" hide />
                  <RTooltip
                    cursor={{ stroke: "rgba(255,255,255,0.15)" }}
                    contentStyle={TOOLTIP_STYLE}
                    labelFormatter={(v) => `Неделя с ${fmtWeek(String(v))}`}
                    formatter={(value, name) =>
                      name === "avg" ? [value, "Средний балл"] : [value, "Ответов"]
                    }
                  />
                  <Bar
                    yAxisId="count"
                    dataKey="count"
                    fill="rgba(96,165,250,0.18)"
                    radius={[3, 3, 0, 0]}
                    maxBarSize={28}
                  />
                  <Line
                    yAxisId="avg"
                    type="monotone"
                    dataKey="avg"
                    stroke="#60a5fa"
                    strokeWidth={2}
                    dot={{ r: 2.5, fill: "#60a5fa" }}
                    activeDot={{ r: 4 }}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </section>

          {/* Структура ответов + распределение оценок */}
          <div className="grid gap-4 lg:grid-cols-2">
            <section>
              <div className="mb-2 flex items-baseline justify-between gap-2">
                <h3 className="text-xs uppercase tracking-wider text-slate-500">
                  Структура по неделям
                </h3>
                <span className="text-[11px] text-slate-500">
                  <span className="text-emerald-300">9–10</span> ·{" "}
                  <span className="text-amber-300">7–8</span> ·{" "}
                  <span className="text-red-300">0–6</span>
                </span>
              </div>
              <div className="rounded-lg border border-white/10 bg-slate-900/40 p-3" style={{ cursor: "pointer" }}>
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart
                    data={structureData}
                    stackOffset="expand"
                    margin={{ top: 8, right: 0, bottom: 0, left: -16 }}
                    onClick={(state) => {
                      const lbl = (state as { activeLabel?: string | number } | null)?.activeLabel;
                      if (lbl != null) setSelectedWeek(String(lbl));
                    }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                    <XAxis
                      dataKey="weekStart"
                      tickFormatter={fmtWeek}
                      tick={{ fill: "#94a3b8", fontSize: 11 }}
                      axisLine={{ stroke: "rgba(255,255,255,0.1)" }}
                      tickLine={false}
                      minTickGap={24}
                    />
                    <YAxis hide />
                    <RTooltip
                      cursor={{ fill: "rgba(255,255,255,0.04)" }}
                      contentStyle={TOOLTIP_STYLE}
                      labelFormatter={(v) => `Неделя с ${fmtWeek(String(v))}`}
                      formatter={(_value, name, entry) => {
                        const p = entry?.payload as (typeof structureData)[number] | undefined;
                        if (!p) return [String(_value), String(name)];
                        if (name === "промоутеры") return [`${p.promoters} (${p.promotersPct}%)`, "9–10"];
                        if (name === "нейтралы") return [`${p.passives} (${p.passivesPct}%)`, "7–8"];
                        return [`${p.detractors} (${p.detractorsPct}%)`, "0–6"];
                      }}
                    />
                    <Bar dataKey="detractors" name="критики" stackId="s" fill="#f87171" maxBarSize={28} />
                    <Bar dataKey="passives" name="нейтралы" stackId="s" fill="#fbbf24" maxBarSize={28} />
                    <Bar dataKey="promoters" name="промоутеры" stackId="s" fill="#34d399" radius={[3, 3, 0, 0]} maxBarSize={28} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </section>

            <section>
              <div className="mb-2 flex items-baseline justify-between gap-2">
                <h3 className="text-xs uppercase tracking-wider text-slate-500">
                  Распределение оценок (за период)
                </h3>
              </div>
              <div className="rounded-lg border border-white/10 bg-slate-900/40 p-3">
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={stats.distribution} margin={{ top: 8, right: 0, bottom: 0, left: -16 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                    <XAxis
                      dataKey="score"
                      tick={{ fill: "#94a3b8", fontSize: 11 }}
                      axisLine={{ stroke: "rgba(255,255,255,0.1)" }}
                      tickLine={false}
                    />
                    <YAxis
                      allowDecimals={false}
                      tick={{ fill: "#94a3b8", fontSize: 11 }}
                      axisLine={false}
                      tickLine={false}
                    />
                    <RTooltip
                      cursor={{ fill: "rgba(255,255,255,0.04)" }}
                      contentStyle={TOOLTIP_STYLE}
                      labelFormatter={(v) => `Оценка ${v}`}
                      formatter={(v) => [v, "Ответов"]}
                    />
                    <Bar dataKey="count" radius={[3, 3, 0, 0]} maxBarSize={28} fill="#60a5fa" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </section>
          </div>

          {/* Анонимные цитаты. Клик по графику фильтрует по неделе. */}
          <section>
            <div className="mb-2 flex flex-wrap items-baseline gap-2">
              <h3 className="text-xs uppercase tracking-wider text-slate-500">Ответы</h3>
              {selectedWeek && (
                <button
                  onClick={() => setSelectedWeek(null)}
                  className="inline-flex items-center gap-1 rounded-md bg-blue-500/15 px-2 py-0.5 text-[11px] text-blue-300 hover:bg-blue-500/25"
                >
                  неделя с {fmtWeek(selectedWeek)}
                  <X className="h-3 w-3" />
                </button>
              )}
              <span className="ml-auto text-[11px] text-slate-500">
                анонимно · {quotes.length} отв.
              </span>
            </div>
            <div className="grid gap-4 lg:grid-cols-2">
              <QuoteList
                title="Что поддерживает"
                accent="text-emerald-300"
                items={supportsQuotes.map((r) => ({ ...r, text: r.supports as string }))}
              />
              <QuoteList
                title="Что мешает"
                accent="text-red-300"
                items={frustratesQuotes.map((r) => ({ ...r, text: r.frustrates as string }))}
              />
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function QuoteList({
  title,
  accent,
  items,
}: {
  title: string;
  accent: string;
  items: Array<ResponseItem & { text: string }>;
}) {
  return (
    <div className="rounded-lg border border-white/10 bg-slate-900/40 p-4">
      <h4 className={`mb-3 text-xs font-semibold uppercase tracking-wider ${accent}`}>{title}</h4>
      {items.length === 0 ? (
        <div className="py-4 text-center text-xs text-slate-500">Нет ответов.</div>
      ) : (
        <ul className="flex max-h-96 flex-col gap-2 overflow-y-auto pr-1">
          {items.map((r, i) => (
            <li
              key={`${r.submittedAt}-${i}`}
              className="rounded-md border border-white/5 bg-slate-950/40 px-3 py-2"
            >
              <div className="text-sm text-slate-200">{r.text}</div>
              <div className="mt-1 flex items-center gap-2 text-[11px] text-slate-500">
                <span className={`rounded px-1.5 py-0.5 font-semibold ${scoreBadgeClass(r.score)}`}>
                  {r.score}
                </span>
                {fmtDateTime(r.submittedAt)}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
