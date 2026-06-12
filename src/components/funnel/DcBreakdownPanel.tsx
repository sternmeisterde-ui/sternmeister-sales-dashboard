"use client";

import { useEffect, useRef, useState } from "react";
import type {
  DcBreakdownResponse,
  DcBucketKey,
} from "@/lib/funnel/api-types";
import { fmtCount, fmtPercent } from "@/lib/funnel/format";
import LeadDrillPopover from "@/components/funnel/LeadDrillPopover";

interface Props {
  /** Текущие фильтры воронки (from/to/source/responsible_user_id). */
  drillBaseParams: URLSearchParams;
  /** Конверсия на моках — разбор не считаем. */
  isMock?: boolean;
}

interface DrillState {
  anchorEl: HTMLElement;
  bucket: DcBucketKey;
  title: string;
}

const LOST_KEYS: DcBucketKey[] = ["closed", "delayed"];
const LABELS: Record<DcBucketKey, string> = {
  forward: "Продвинулись в АА",
  stayed: "Остались на этапе ДЦ",
  closed: "Закрыто и не реализовано",
  delayed: "Отложенный старт",
};

export default function DcBreakdownPanel({ drillBaseParams, isMock = false }: Props) {
  const [data, setData] = useState<DcBreakdownResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drill, setDrill] = useState<DrillState | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const paramsKey = drillBaseParams.toString();
  useEffect(() => {
    if (isMock) {
      setData(null);
      setError("Разбор недоступен (конверсия на моках)");
      return;
    }
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    setError(null);
    setDrill(null);
    fetch(`/api/funnel/dc-breakdown?${paramsKey}`, { signal: ctrl.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text().catch(() => "")}`);
        return res.json();
      })
      .then((d: DcBreakdownResponse) => {
        if (abortRef.current !== ctrl) return;
        setData(d);
        setLoading(false);
      })
      .catch((e) => {
        if ((e as Error).name === "AbortError") return;
        if (abortRef.current !== ctrl) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      });
    return () => ctrl.abort();
  }, [paramsKey, isMock]);

  const total = data?.total ?? 0;
  const pct = (n: number) => (total > 0 ? (n / total) * 100 : null);
  const lostTotal = data
    ? LOST_KEYS.reduce((s, k) => s + data.buckets[k].count, 0)
    : 0;

  const openDrill = (e: React.MouseEvent<HTMLButtonElement>, bucket: DcBucketKey) => {
    setDrill({ anchorEl: e.currentTarget, bucket, title: LABELS[bucket] });
  };

  return (
    <section
      className="glass-panel rounded-2xl border border-white/5 p-4 flex flex-col gap-3"
      aria-label="Разбор когорты C3.1"
    >
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-base font-semibold text-white">
          Разбор когорты: куда делись после Термина ДЦ
        </h3>
        <span className="text-[11px] text-slate-400 tabular-nums whitespace-nowrap">
          {loading ? "загрузка…" : `Термин ДЦ состоялся: ${fmtCount(total)}`}
        </span>
      </div>

      {error ? (
        <div className="text-sm text-rose-300/80 py-4">{error}</div>
      ) : !data ? (
        <div className="text-sm text-slate-500 py-4">Загрузка…</div>
      ) : total === 0 ? (
        <div className="text-sm text-slate-500 py-4">
          Нет лидов с состоявшимся Термином ДЦ в выбранном периоде.
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          <BucketRow
            label="✅ Продвинулись в АА"
            count={data.buckets.forward.count}
            pct={pct(data.buckets.forward.count)}
            tone="emerald"
            active={drill?.bucket === "forward"}
            onClick={(e) => openDrill(e, "forward")}
          />
          <BucketRow
            label="⏳ Остались на этапе ДЦ"
            count={data.buckets.stayed.count}
            pct={pct(data.buckets.stayed.count)}
            tone="amber"
            active={drill?.bucket === "stayed"}
            onClick={(e) => openDrill(e, "stayed")}
          />
          <div className="flex items-center justify-between gap-2 px-2.5 pt-1.5 text-sm">
            <span className="text-rose-300 font-medium">❌ Потеряны</span>
            <span className="tabular-nums shrink-0">
              <span className="font-semibold text-slate-100">{fmtCount(lostTotal)}</span>
              <span className="text-slate-500 ml-1.5">({fmtPercent(pct(lostTotal), 1)})</span>
            </span>
          </div>
          {LOST_KEYS.map((k) => (
            <BucketRow
              key={k}
              indent
              label={LABELS[k]}
              count={data.buckets[k].count}
              pct={pct(data.buckets[k].count)}
              tone="rose"
              active={drill?.bucket === k}
              onClick={(e) => openDrill(e, k)}
            />
          ))}
        </div>
      )}

      <p className="text-[10px] text-slate-500 leading-snug">
        За выбранный период. Свежие недели ещё дозревают — «остались на этапе»
        будет завышено, пока лиды в полёте.
      </p>

      {drill && data && (
        <LeadDrillPopover
          anchorEl={drill.anchorEl}
          title={drill.title}
          subtitle="C3.1 · разбор когорты"
          totalCount={data.buckets[drill.bucket].count}
          leads={data.buckets[drill.bucket].leads}
          onClose={() => setDrill(null)}
        />
      )}
    </section>
  );
}

function BucketRow({
  label,
  count,
  pct,
  tone,
  indent = false,
  active,
  onClick,
}: {
  label: string;
  count: number;
  pct: number | null;
  tone: "emerald" | "amber" | "rose";
  indent?: boolean;
  active: boolean;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  const toneText =
    tone === "emerald"
      ? "text-emerald-300"
      : tone === "amber"
        ? "text-amber-300"
        : "text-rose-300/90";
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-sm text-left transition-colors ${
        indent ? "ml-4" : ""
      } ${
        active
          ? "bg-blue-500/15 border border-blue-400/30"
          : "border border-transparent hover:bg-white/[0.03]"
      }`}
    >
      <span className={indent ? "text-slate-400" : toneText}>{label}</span>
      <span className="tabular-nums shrink-0">
        <span className="font-semibold text-slate-100">{fmtCount(count)}</span>
        <span className="text-slate-500 ml-1.5">({fmtPercent(pct, 1)})</span>
      </span>
    </button>
  );
}
