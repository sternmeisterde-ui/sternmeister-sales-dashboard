"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ExternalLink, Loader2, TriangleAlert, X } from "lucide-react";

export interface DrillLead {
  leadId: number;
  name: string;
  kommoUrl: string;
  currentStatus?: string | null;
}

interface Props {
  /** Опорный элемент — pill-кнопка, рядом с которой раскрывается панель. */
  anchorEl: HTMLElement;
  /** Заголовок «Лиды» или «Факт». */
  title: string;
  /** Подзаголовок (id конверсии, неделя). */
  subtitle: string;
  /** Полное число (может быть больше длины leads — отображаем «показано N»). */
  totalCount: number;
  leads: DrillLead[];
  loading?: boolean;
  error?: string | null;
  onClose: () => void;
}

const PANEL_WIDTH = 280;
const PANEL_MAX_HEIGHT = 320;

export default function LeadDrillPopover({
  anchorEl,
  title,
  subtitle,
  totalCount,
  leads,
  loading = false,
  error = null,
  onClose,
}: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(
    null
  );

  // Позиционируем: справа от anchor если влезает, иначе слева; вертикально — у верха anchor.
  useLayoutEffect(() => {
    function compute() {
      const rect = anchorEl.getBoundingClientRect();
      const vw = document.documentElement.clientWidth;
      const vh = document.documentElement.clientHeight;
      const margin = 8;

      let left = rect.right + margin;
      if (left + PANEL_WIDTH > vw - margin) {
        left = Math.max(margin, rect.left - PANEL_WIDTH - margin);
      }
      let top = rect.top - 4;
      if (top + PANEL_MAX_HEIGHT > vh - margin) {
        top = Math.max(margin, vh - PANEL_MAX_HEIGHT - margin);
      }
      setPosition({ left, top });
    }
    compute();
    window.addEventListener("resize", compute);
    window.addEventListener("scroll", compute, true);
    return () => {
      window.removeEventListener("resize", compute);
      window.removeEventListener("scroll", compute, true);
    };
  }, [anchorEl]);

  // Esc + клик снаружи — закрывают.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    function onMouseDown(e: MouseEvent) {
      if (!panelRef.current) return;
      const t = e.target as Node;
      if (panelRef.current.contains(t)) return;
      if (anchorEl.contains(t)) return;
      onClose();
    }
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onMouseDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onMouseDown);
    };
  }, [anchorEl, onClose]);

  if (position === null) return null;

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label={`${title} — ${subtitle}`}
      style={{
        position: "fixed",
        left: position.left,
        top: position.top,
        width: PANEL_WIDTH,
        maxHeight: PANEL_MAX_HEIGHT,
        background: "#0f172a",
        border: "1px solid rgba(255,255,255,0.1)",
        borderRadius: 10,
        boxShadow: "0 12px 32px rgba(0,0,0,0.45)",
        zIndex: 60,
      }}
      className="flex flex-col"
    >
      <div className="flex items-start justify-between gap-2 px-3 py-2 border-b border-white/5">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-white flex items-baseline gap-2">
            {title}
            <span className="text-[11px] text-slate-400 tabular-nums">
              {totalCount}
            </span>
          </div>
          <div className="text-[10px] text-slate-400 truncate">{subtitle}</div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-slate-500 hover:text-white transition-colors"
          aria-label="Закрыть"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="overflow-y-auto flex-1 min-h-0">
        {loading ? (
          <div className="px-3 py-6 text-[11px] text-slate-400 text-center flex items-center justify-center gap-2">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            Загрузка…
          </div>
        ) : error ? (
          <div className="px-3 py-4 text-[11px] text-rose-300 flex items-start gap-1.5">
            <TriangleAlert className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        ) : leads.length === 0 ? (
          <div className="px-3 py-4 text-[11px] text-slate-500 text-center">
            Нет сделок
          </div>
        ) : (
          <ul className="flex flex-col">
            {leads.map((lead) => (
              <li key={lead.leadId}>
                <a
                  href={lead.kommoUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center justify-between gap-2 px-3 py-1.5 text-xs text-slate-200 hover:bg-white/5 transition-colors"
                >
                  <div className="min-w-0 flex flex-col">
                    <span className="truncate">{lead.name}</span>
                    {lead.currentStatus && (
                      <span className="text-[10px] text-slate-500 truncate">
                        {lead.currentStatus}
                      </span>
                    )}
                  </div>
                  <ExternalLink className="w-3 h-3 text-slate-500 shrink-0" />
                </a>
              </li>
            ))}
            {leads.length < totalCount && (
              <li className="px-3 py-2 text-[10px] text-slate-500 text-center border-t border-white/5">
                Показано {leads.length} из {totalCount}
              </li>
            )}
          </ul>
        )}
      </div>
    </div>,
    document.body
  );
}
