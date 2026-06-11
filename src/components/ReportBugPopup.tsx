"use client";

import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { X, Send, Loader2, Bug } from "lucide-react";

interface ReporterInfo {
  name: string;
  role: "admin" | "rop" | "teamlead" | "manager";
  department: "b2g" | "b2b";
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  reporter: ReporterInfo | null;
}

// Mirrors the sidebar menu. Keep in sync with src/app/page.tsx.
const SECTIONS: Array<{ id: string; label: string }> = [
  { id: "dashboard", label: "Звонки" },
  { id: "daily", label: "Дейли" },
  { id: "analytics", label: "Аналитика" },
  { id: "tracking", label: "Активность" },
  { id: "looker", label: "Looker" },
  { id: "real_calls", label: "ОКК" },
  { id: "ai_calls", label: "AI Ролевки" },
  { id: "managers", label: "Менеджеры" },
  { id: "call_analysis", label: "Анализ" },
  { id: "criteria", label: "Критерии" },
  { id: "scripts", label: "Скрипты" },
];

const ROLE_LABEL: Record<string, string> = {
  admin: "Админ",
  rop: "РОП",
  teamlead: "Тимлид",
  manager: "Менеджер",
};

const DEPT_LABEL: Record<string, string> = {
  b2g: "Госники",
  b2b: "Коммерсы",
};

function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default function ReportBugPopup({ isOpen, onClose, reporter }: Props) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  const [section, setSection] = useState<string>(SECTIONS[0].id);
  const [description, setDescription] = useState("");
  const [reportDate, setReportDate] = useState(todayISO());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  // Reset form each time popup opens
  useEffect(() => {
    if (isOpen) {
      setSection(SECTIONS[0].id);
      setDescription("");
      setReportDate(todayISO());
      setError(null);
      setSuccess(false);
    }
  }, [isOpen]);

  const submit = async () => {
    if (submitting) return;
    setError(null);
    const trimmed = description.trim();
    if (trimmed.length < 5) {
      setError("Опишите проблему подробнее (минимум 5 символов)");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/bug-reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ section, description: trimmed, reportDate }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !json.ok) {
        setError(json.error ?? "Не удалось отправить обращение");
        return;
      }
      setSuccess(true);
      // Auto-close after brief success state
      setTimeout(() => { onClose(); }, 1200);
    } catch (e) {
      setError("Не удалось подключиться к серверу");
      console.error(e);
    } finally {
      setSubmitting(false);
    }
  };

  if (!isOpen || !mounted) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
      onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}
    >
      <div
        className="w-full max-w-md bg-slate-900 border border-white/10 rounded-2xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/10">
          <div className="flex items-center gap-2">
            <Bug className="w-4 h-4 text-rose-400" />
            <h2 className="text-sm font-bold text-white tracking-wide">Сообщить об ошибке</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 transition-colors"
            aria-label="Закрыть"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-5 flex flex-col gap-4">
          {/* Reporter info — auto-filled from session, not editable */}
          {reporter ? (
            <div className="grid grid-cols-3 gap-2 text-[11px]">
              <div className="bg-slate-800/60 rounded-lg px-3 py-2">
                <div className="text-[9px] uppercase tracking-widest text-slate-500 mb-0.5">От</div>
                <div className="text-slate-200 font-medium truncate">{reporter.name}</div>
              </div>
              <div className="bg-slate-800/60 rounded-lg px-3 py-2">
                <div className="text-[9px] uppercase tracking-widest text-slate-500 mb-0.5">Роль</div>
                <div className="text-slate-200 font-medium">{ROLE_LABEL[reporter.role] ?? reporter.role}</div>
              </div>
              <div className="bg-slate-800/60 rounded-lg px-3 py-2">
                <div className="text-[9px] uppercase tracking-widest text-slate-500 mb-0.5">Отдел</div>
                <div className="text-slate-200 font-medium">{DEPT_LABEL[reporter.department] ?? reporter.department}</div>
              </div>
            </div>
          ) : (
            <div className="text-xs text-amber-400">Не удалось определить пользователя</div>
          )}

          {/* Section + Date row */}
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="br-section" className="text-[10px] uppercase tracking-widest text-slate-400 font-semibold">
                Раздел
              </label>
              <select
                id="br-section"
                value={section}
                onChange={(e) => setSection(e.target.value)}
                disabled={submitting}
                className="bg-slate-800/60 border border-white/10 rounded-xl px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-blue-500/50 transition-colors disabled:opacity-50"
              >
                {SECTIONS.map((s) => (
                  <option key={s.id} value={s.id}>{s.label}</option>
                ))}
              </select>
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="br-date" className="text-[10px] uppercase tracking-widest text-slate-400 font-semibold">
                Дата
              </label>
              <input
                id="br-date"
                type="date"
                value={reportDate}
                onChange={(e) => setReportDate(e.target.value)}
                disabled={submitting}
                className="bg-slate-800/60 border border-white/10 rounded-xl px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-blue-500/50 transition-colors disabled:opacity-50"
              />
            </div>
          </div>

          {/* Description */}
          <div className="flex flex-col gap-1.5">
            <label htmlFor="br-description" className="text-[10px] uppercase tracking-widest text-slate-400 font-semibold">
              Описание проблемы
            </label>
            <textarea
              id="br-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={submitting}
              rows={5}
              maxLength={4000}
              placeholder="Что произошло, что вы ожидали увидеть, как воспроизвести…"
              className="bg-slate-800/60 border border-white/10 rounded-xl px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-blue-500/50 transition-colors disabled:opacity-50 resize-none placeholder:text-slate-500"
            />
            <div className="text-[10px] text-slate-600 text-right">
              {description.length}/4000
            </div>
          </div>

          {error && (
            <div className="rounded-xl border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-400">
              {error}
            </div>
          )}
          {success && (
            <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-400">
              Обращение отправлено ✓
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-white/10 bg-slate-900/60">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="px-4 py-2 rounded-xl text-xs font-semibold text-slate-400 hover:text-white transition-colors disabled:opacity-50"
          >
            Отмена
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={submitting || success || !reporter}
            className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold bg-gradient-to-r from-blue-600 to-indigo-500 text-white shadow-lg hover:-translate-y-0.5 hover:shadow-blue-500/40 transition-all disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:translate-y-0"
          >
            {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
            Отправить
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
