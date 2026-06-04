"use client";

import { useState, useEffect, useCallback } from "react";
import { AlertTriangle, CheckCircle2, TrendingDown, Zap } from "lucide-react";

interface CoverageRow {
  manager_name: string;
  date: string;
  okk_count: number;
  phantom_count: number;
  coverage_pct: number | null;
}

interface OverrideRow {
  prompt_type: string;
  total_evals: number;
  override_fired_count: number;
  avg_score_delta: number | null;
}

interface SignalRow {
  source: string;
  n: number;
}

interface CallTypeRow {
  call_type: string;
  n: number;
}

interface AuditPayload {
  dept: "b2g" | "b2b";
  from: string;
  to: string;
  coverage: CoverageRow[];
  overrides: OverrideRow[];
  signal_quality: SignalRow[];
  call_types: CallTypeRow[];
}

const COVERAGE_COLOR = (pct: number | null): string => {
  if (pct === null) return "bg-zinc-200 dark:bg-zinc-800";
  if (pct >= 95) return "bg-emerald-500/80";
  if (pct >= 85) return "bg-amber-400/80";
  return "bg-red-500/80";
};

const SIGNAL_LABEL: Record<string, string> = {
  lead_id: "По CRM-лиду (надёжно)",
  phone_fallback: "По телефону + пайплайн (средне)",
  phone_fallback_no_crm: "Только телефон (слабо)",
  no_signal: "Без сигнала (legacy)",
};

const CALL_TYPE_LABEL: Record<string, string> = {
  primary: "Первичный",
  followup: "Повторный",
  interrupted: "Прерванный",
  unqualified: "Неквал",
  transfer: "Переадресация",
  deferred_start: "Отложенный старт",
  unknown: "Не определено",
};

export default function AuditTab({
  department,
}: {
  department: "b2g" | "b2b";
}) {
  const [data, setData] = useState<AuditPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/okk/audit?dept=${department}`);
      if (!res.ok) {
        setError(`HTTP ${res.status}`);
        return;
      }
      const json = await res.json();
      if (json.error) {
        setError(json.error);
        return;
      }
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : "fetch failed");
    } finally {
      setLoading(false);
    }
  }, [department]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  if (loading) {
    return <div className="p-6 text-sm text-zinc-500">Загрузка аудита…</div>;
  }
  if (error || !data) {
    return (
      <div className="p-6 text-sm text-red-500">
        Ошибка: {error || "no data"}
      </div>
    );
  }

  // Coverage heatmap data — pivot by (manager × date)
  const managers = Array.from(
    new Set(data.coverage.map((r) => r.manager_name))
  ).sort();
  const dates = Array.from(new Set(data.coverage.map((r) => r.date))).sort();
  const coverageMap = new Map<string, CoverageRow>();
  for (const r of data.coverage) coverageMap.set(`${r.manager_name}|${r.date}`, r);

  const totalSignals = data.signal_quality.reduce((s, r) => s + r.n, 0);
  const totalCallTypes = data.call_types.reduce((s, r) => s + r.n, 0);

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Аудит оценок</h1>
          <p className="text-sm text-zinc-500">
            Окно: {data.from} → {data.to} · Отдел:{" "}
            {department === "b2g" ? "B2G (Госники)" : "B2C (Коммерсы)"}
          </p>
        </div>
      </div>

      {/* Override Impact */}
      <section className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-4">
        <div className="flex items-center gap-2 mb-3">
          <Zap className="h-4 w-4 text-amber-500" />
          <h2 className="font-semibold">
            Программный override — за период
          </h2>
        </div>
        {data.overrides.length === 0 ? (
          <p className="text-sm text-zinc-500">Нет данных за период.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-zinc-500">
              <tr>
                <th className="py-2">Промпт</th>
                <th className="py-2 text-right">Оценок</th>
                <th className="py-2 text-right">Override сработал</th>
                <th className="py-2 text-right">% от оценок</th>
                <th className="py-2 text-right">Δ score</th>
              </tr>
            </thead>
            <tbody>
              {data.overrides.map((r) => {
                const pct =
                  r.total_evals > 0
                    ? Math.round((r.override_fired_count / r.total_evals) * 100)
                    : 0;
                return (
                  <tr key={r.prompt_type} className="border-t border-zinc-200/50 dark:border-zinc-800/50">
                    <td className="py-2 font-mono text-xs">{r.prompt_type}</td>
                    <td className="py-2 text-right">{r.total_evals}</td>
                    <td className="py-2 text-right">{r.override_fired_count}</td>
                    <td className="py-2 text-right">{pct}%</td>
                    <td className="py-2 text-right tabular-nums">
                      {r.avg_score_delta !== null ? (
                        <span
                          className={
                            r.avg_score_delta > 0
                              ? "text-emerald-500"
                              : r.avg_score_delta < 0
                              ? "text-red-500"
                              : "text-zinc-500"
                          }
                        >
                          {r.avg_score_delta > 0 ? "+" : ""}
                          {r.avg_score_delta}
                        </span>
                      ) : (
                        <span className="text-zinc-400">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      {/* Signal Quality */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <section className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-4">
          <h2 className="font-semibold mb-3 flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-blue-500" />
            Источник follow-up сигнала
          </h2>
          <div className="space-y-2">
            {data.signal_quality.map((r) => {
              const pct =
                totalSignals > 0 ? Math.round((r.n / totalSignals) * 100) : 0;
              return (
                <div key={r.source} className="text-sm">
                  <div className="flex justify-between">
                    <span>{SIGNAL_LABEL[r.source] || r.source}</span>
                    <span className="tabular-nums text-zinc-500">
                      {r.n} ({pct}%)
                    </span>
                  </div>
                  <div className="mt-1 h-1.5 rounded bg-zinc-200 dark:bg-zinc-800 overflow-hidden">
                    <div
                      className="h-full bg-blue-500"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <section className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-4">
          <h2 className="font-semibold mb-3 flex items-center gap-2">
            <TrendingDown className="h-4 w-4 text-violet-500" />
            Распределение по call_type
          </h2>
          <div className="space-y-2">
            {data.call_types.map((r) => {
              const pct =
                totalCallTypes > 0
                  ? Math.round((r.n / totalCallTypes) * 100)
                  : 0;
              return (
                <div key={r.call_type} className="text-sm">
                  <div className="flex justify-between">
                    <span>{CALL_TYPE_LABEL[r.call_type] || r.call_type}</span>
                    <span className="tabular-nums text-zinc-500">
                      {r.n} ({pct}%)
                    </span>
                  </div>
                  <div className="mt-1 h-1.5 rounded bg-zinc-200 dark:bg-zinc-800 overflow-hidden">
                    <div
                      className="h-full bg-violet-500"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      </div>

      {/* Webhook Coverage Heatmap */}
      <section className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-4">
        <div className="flex items-center gap-2 mb-3">
          <AlertTriangle className="h-4 w-4 text-red-500" />
          <h2 className="font-semibold">Покрытие webhook (telephony → OKK)</h2>
        </div>
        <p className="text-xs text-zinc-500 mb-3">
          Зелёный ≥95% / жёлтый 85–95% / красный &lt;85%. Серое = нет звонков.
          Считается из CDR (CallGear + CloudTalk), сравнивается с записанными
          в OKK callами.
        </p>
        {managers.length === 0 ? (
          <p className="text-sm text-zinc-500">
            Нет данных по покрытию. CDR sync ещё не запускался — первая
            пробежка завтра в 06:00 МСК.
          </p>
        ) : (
          <div className="overflow-auto">
            <table className="text-xs">
              <thead>
                <tr>
                  <th className="text-left py-1 pr-2 sticky left-0 bg-white dark:bg-zinc-950">
                    Менеджер
                  </th>
                  {dates.map((d) => (
                    <th
                      key={d}
                      className="text-center px-1 font-normal text-zinc-500"
                      style={{ minWidth: 26 }}
                    >
                      {d.slice(5)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {managers.map((m) => (
                  <tr key={m}>
                    <td className="py-1 pr-2 sticky left-0 bg-white dark:bg-zinc-950">
                      {m}
                    </td>
                    {dates.map((d) => {
                      const cell = coverageMap.get(`${m}|${d}`);
                      return (
                        <td key={d} className="px-0.5 py-1">
                          <div
                            className={`h-5 w-5 rounded ${COVERAGE_COLOR(cell?.coverage_pct ?? null)}`}
                            title={
                              cell
                                ? `${m} · ${d}: ${cell.coverage_pct}% (OKK ${cell.okk_count} / phantom ${cell.phantom_count})`
                                : `${m} · ${d}: нет звонков`
                            }
                          />
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
