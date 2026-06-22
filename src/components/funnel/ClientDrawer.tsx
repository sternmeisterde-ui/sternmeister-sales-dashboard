"use client";

import { useEffect, useState } from "react";
import { X, ExternalLink, Loader2, Phone, Mail, MessageSquare, StickyNote, Activity } from "lucide-react";
import type { ClientRow, ClientSideReadiness } from "@/lib/funnel/clients";
import type { ClientDetail, ClientTouch } from "@/lib/funnel/client-detail";

interface Props {
  client: ClientRow;
  onClose: () => void;
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
  unknown: "не указан",
};

function scoreColor(s5: number): string {
  if (s5 >= 4) return "text-emerald-300";
  if (s5 === 3) return "text-amber-300";
  return "text-rose-300";
}

function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("ru-RU", {
    day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
    timeZone: "Europe/Berlin",
  });
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("ru-RU", {
    day: "2-digit", month: "2-digit", year: "2-digit", timeZone: "Europe/Berlin",
  });
}

function fmtDuration(sec: number | null): string | null {
  if (!sec || sec <= 0) return null;
  const m = Math.floor(sec / 60);
  return `${m}:${String(sec % 60).padStart(2, "0")}`;
}

// Тип касания → читаемый ярлык + иконка. communication_type из Kommo
// (call_out/call_in, outgoing/incoming_chat_message…) матчим по подстроке.
// category — это буквенный код (E/C/D…), для ярлыка не используем.
function touchKind(t: ClientTouch): { label: string; Icon: typeof Phone } {
  const s = (t.type ?? "").toLowerCase();
  const dir = /(^|_)in|incoming/.test(s) ? " вх." : /(^|_)out|outgoing/.test(s) ? " исх." : "";
  if (s.includes("call") || s.includes("звон")) return { label: "Звонок" + dir, Icon: Phone };
  if (s.includes("mail") || s.includes("письм")) return { label: "Письмо" + dir, Icon: Mail };
  if (s.includes("chat") || s.includes("message") || s.includes("сообщ")) return { label: "Сообщение" + dir, Icon: MessageSquare };
  if (s.includes("note") || s.includes("замет")) return { label: "Заметка", Icon: StickyNote };
  return { label: t.type || "Касание", Icon: Activity };
}

function SideDynamics({ label, side }: { label: string; side: ClientSideReadiness }) {
  return (
    <div className="flex items-center justify-between text-sm py-1.5">
      <span className="text-slate-400">Ролевка {label}</span>
      {side.attempts.length === 0 ? (
        <span className="text-slate-600">нет</span>
      ) : (
        <span className="inline-flex items-center gap-1.5 tabular-nums">
          {side.attempts.map((s, i) => (
            <span key={i} className="inline-flex items-center gap-1.5">
              {i > 0 && <span className="text-slate-600">→</span>}
              <span className={`font-semibold ${scoreColor(s)}`}>{s}</span>
            </span>
          ))}
          <span className="text-[11px] text-slate-500 ml-1">
            (попыток: {side.attempts.length})
          </span>
        </span>
      )}
    </div>
  );
}

export default function ClientDrawer({ client, onClose }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Детали (таймлайн касаний + история стадий) грузим лениво при открытии.
  const [detail, setDetail] = useState<ClientDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(true);
  // Смена клиента — сбрасываем в загрузку прямо в рендере (приём React без
  // setState-в-эффекте), а эффект только дёргает fetch и пишет в async-колбэках.
  const [seenLead, setSeenLead] = useState(client.leadId);
  if (seenLead !== client.leadId) {
    setSeenLead(client.leadId);
    setDetail(null);
    setDetailLoading(true);
  }
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/funnel/clients/${client.leadId}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: ClientDetail) => { if (!cancelled) setDetail(d); })
      .catch(() => { if (!cancelled) setDetail({ touches: [], stages: [] }); })
      .finally(() => { if (!cancelled) setDetailLoading(false); });
    return () => { cancelled = true; };
  }, [client.leadId]);

  const cat = CATEGORY[client.category];

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      {/* Overlay */}
      <div
        className="absolute inset-0 bg-black/50"
        onClick={onClose}
        aria-hidden="true"
      />
      {/* Panel */}
      <div className="relative w-full max-w-md h-full bg-slate-900 border-l border-white/10 shadow-2xl overflow-y-auto">
        <div className="flex items-start justify-between px-5 py-4 border-b border-white/5 sticky top-0 bg-slate-900 z-10">
          <div className="min-w-0">
            <div className="text-base font-semibold text-white truncate">
              {client.name}
            </div>
            <a
              href={client.kommoUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-blue-300 hover:text-blue-200 mt-0.5"
            >
              Открыть в Kommo <ExternalLink className="w-3 h-3" />
            </a>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-md text-slate-400 hover:text-white hover:bg-white/5"
            aria-label="Закрыть"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-5">
          {/* Score */}
          <div className="flex items-center gap-3">
            <div className="text-4xl font-bold text-white tabular-nums">
              {client.score}
            </div>
            <div className="flex flex-col">
              <span className={`text-xs px-2 py-0.5 rounded-md border w-fit ${cat.cls}`}>
                {cat.label}
              </span>
              <span className="text-[11px] text-slate-500 mt-1">
                готовность к термину
              </span>
            </div>
          </div>

          {/* Атрибуты */}
          <div className="space-y-1 text-sm border-t border-white/5 pt-3">
            <Row label="Этап" value={client.status ?? "—"} />
            <Row label="Язык" value={LANG_LABEL[client.languageBucket]} />
            <Row
              label="Последняя активность"
              value={
                client.daysSinceLastTouch === null
                  ? "нет касаний"
                  : client.daysSinceLastTouch === 0
                    ? "сегодня"
                    : `${client.daysSinceLastTouch} дн. назад`
              }
            />
            <SideDynamics label="ДЦ" side={client.dc} />
            <SideDynamics label="АА" side={client.aa} />
            <Row
              label="Ролевки с ботом"
              value={
                client.botRoleplayCount > 0
                  ? `${client.botRoleplayCount}${client.botLatestReadiness ? ` · ${client.botLatestReadiness}` : ""}`
                  : "нет"
              }
            />
          </div>

          {/* Breakdown score */}
          <div className="border-t border-white/5 pt-3">
            <div className="text-[10px] uppercase tracking-widest font-semibold text-slate-500 mb-2">
              Из чего складывается готовность
            </div>
            <div className="space-y-2">
              {client.factors.map((f) => (
                <div key={f.key}>
                  <div className="flex items-center justify-between text-xs mb-1">
                    <span className="text-slate-300">
                      {f.label}
                      <span className="text-slate-600 ml-1">
                        · вес {Math.round(f.weight * 100)}%
                      </span>
                    </span>
                    <span className="tabular-nums text-slate-400">
                      {f.present ? f.value : "нет данных"}
                    </span>
                  </div>
                  <div className="h-1.5 rounded-full bg-slate-700/50 overflow-hidden">
                    <div
                      className={`h-full rounded-full ${
                        f.present ? "bg-blue-400/70" : "bg-slate-600/50"
                      }`}
                      style={{ width: `${f.value}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
            <p className="text-[11px] text-slate-500 mt-3">
              «Готовность» — индикатор подготовленности к термину (язык + ролевки +
              активность), <span className="text-slate-400">не</span> предиктор
              одобрения гутшайна.
            </p>
          </div>

          {/* История стадий (ТЗ §8) */}
          <StageHistory loading={detailLoading} detail={detail} />

          {/* Таймлайн касаний (ТЗ §8, критерий приёмки #4) */}
          <TouchTimeline loading={detailLoading} detail={detail} />
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-1.5">
      <span className="text-slate-400">{label}</span>
      <span className="text-slate-200 text-right max-w-[60%] truncate">{value}</span>
    </div>
  );
}

function SectionLoader() {
  return (
    <div className="flex items-center gap-2 text-xs text-slate-500">
      <Loader2 className="w-3.5 h-3.5 animate-spin" /> загрузка…
    </div>
  );
}

function StageHistory({ loading, detail }: { loading: boolean; detail: ClientDetail | null }) {
  return (
    <div className="border-t border-white/5 pt-3">
      <div className="text-[10px] uppercase tracking-widest font-semibold text-slate-500 mb-2">
        История стадий
      </div>
      {loading && !detail && <SectionLoader />}
      {detail && detail.stages.length === 0 && (
        <div className="text-xs text-slate-600">нет истории стадий</div>
      )}
      {detail && detail.stages.length > 0 && (
        <ol className="space-y-1.5">
          {/* Новейшая стадия сверху. */}
          {detail.stages.slice().reverse().map((s, i) => {
            const current = s.leftAtIso === null;
            return (
              <li key={i} className="flex items-start justify-between gap-2 text-xs">
                <span className="flex items-start gap-2 min-w-0">
                  <span
                    className={`mt-1 w-1.5 h-1.5 rounded-full shrink-0 ${
                      current ? "bg-emerald-400" : "bg-slate-600"
                    }`}
                  />
                  <span className="min-w-0">
                    <span className={current ? "text-emerald-300" : "text-slate-300"}>
                      {s.status ?? "—"}
                    </span>
                    <span className="block text-[10px] text-slate-600">
                      {fmtDate(s.enteredAtIso)}
                      {s.manager ? ` · ${s.manager}` : ""}
                    </span>
                  </span>
                </span>
                <span className="text-slate-500 tabular-nums shrink-0">
                  {current ? `${s.days} дн · сейчас` : `${s.days} дн`}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

function TouchTimeline({ loading, detail }: { loading: boolean; detail: ClientDetail | null }) {
  return (
    <div className="border-t border-white/5 pt-3">
      <div className="text-[10px] uppercase tracking-widest font-semibold text-slate-500 mb-2">
        Таймлайн касаний
      </div>
      {loading && !detail && <SectionLoader />}
      {detail && detail.touches.length === 0 && (
        <div className="text-xs text-slate-600">нет касаний</div>
      )}
      {detail && detail.touches.length > 0 && (
        <ul className="space-y-1.5">
          {detail.touches.map((t, i) => {
            const { label, Icon } = touchKind(t);
            const dur = fmtDuration(t.durationSec);
            return (
              <li key={i} className="flex items-center gap-2 text-xs">
                <Icon className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                <span className="text-slate-300 shrink-0">{label}</span>
                {dur && <span className="text-slate-500 tabular-nums">{dur}</span>}
                {t.manager && (
                  <span className="text-slate-600 truncate">· {t.manager}</span>
                )}
                <span className="text-slate-500 tabular-nums ml-auto shrink-0">
                  {fmtDateTime(t.atIso)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
