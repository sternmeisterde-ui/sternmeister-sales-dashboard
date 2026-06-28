"use client";

// Общий каркас drill-модалки: портал в body, затемнение, закрытие по клику-вне /
// Escape / крестику, sticky-шапка и скроллируемое тело. Контент шапки (`header`) и тела
// (`children`) задаёт вызывающий. Вынесено из BroadcastTab (3 копии) — единый источник
// поведения a11y/скролла (см. code-review #8). TerminLeadDrillModal — отдельный кейс
// (ленивый fetch), сюда не сводится.

import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

export default function DrillModal({
  header,
  children,
  onClose,
  maxWidthClass = "max-w-3xl",
}: {
  /** Левая часть шапки (заголовок/подзаголовок/метрики). */
  header: ReactNode;
  children: ReactNode;
  onClose: () => void;
  maxWidthClass?: string;
}) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/70 px-4 pt-12 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      tabIndex={-1}
    >
      <div
        className={`flex max-h-[85vh] w-full ${maxWidthClass} flex-col overflow-hidden rounded-2xl border border-white/10 bg-slate-900 shadow-2xl`}
        onClick={(e) => e.stopPropagation()}
        role="document"
      >
        <div className="sticky top-0 z-10 flex items-start gap-3 border-b border-white/5 bg-slate-950/60 px-5 py-4">
          <div className="flex min-w-0 flex-1 flex-col">{header}</div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded-md p-1.5 text-slate-400 transition-colors hover:bg-white/10 hover:text-white"
            aria-label="Закрыть"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
