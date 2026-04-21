"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  BookOpen,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FileText,
  Headphones,
  Loader2,
  MessageSquare,
  Plus,
  Save,
  ShieldAlert,
  Sparkles,
  Trash2,
} from "lucide-react";

// ─── Types ──────────────────────────────────────────────────────

type ItemKind = "item" | "section" | "subheader" | "note" | "objection";

interface ScriptItem {
  id: string;
  kind: ItemKind;
  title?: string;
  script?: string;
  comment?: string;
  note?: string;
  tips?: string;
  editor_note?: string;
}

interface ScriptSection {
  id: string;
  title: string | null;
  items: ScriptItem[];
}

interface ScriptContent {
  sections: ScriptSection[];
}

interface ScriptData {
  exists: boolean;
  department: "b2g" | "b2b";
  line: string;
  title: string;
  notionUrl: string | null;
  content: ScriptContent;
  version: number;
  updatedAt: string | null;
  updatedBy: string | null;
}

interface ScriptsTabProps {
  department: "b2g" | "b2b";
  lineFilter: string;
  isAdmin: boolean;
}

// ─── Line options per department ────────────────────────────────

interface LineOption {
  line: string;
  label: string;
  accent: string; // tailwind class for border/bg accent
}

function getLineOptions(dept: "b2g" | "b2b"): LineOption[] {
  if (dept === "b2b") {
    return [
      { line: "buh1", label: "Бух 1 — Первичное касание", accent: "emerald" },
      { line: "buh2", label: "Бух 2 — Вторичное касание", accent: "violet" },
      { line: "med1", label: "Мед 1 — Medical Admin", accent: "pink" },
    ];
  }
  return [
    { line: "1", label: "Линия 1 — Квалификатор", accent: "blue" },
    { line: "2a", label: "Линия 2 — Бератер 1 (Верх воронки)", accent: "violet" },
    { line: "2b", label: "Линия 2 — Бератер 2 (Низ воронки)", accent: "pink" },
    { line: "3", label: "Линия 3 — Доведение", accent: "emerald" },
  ];
}

function getDefaultLine(dept: "b2g" | "b2b", lineFilter: string): string {
  const options = getLineOptions(dept);
  // Map global lineFilter (1/2/3) to scripts default. For '2' pick '2a' by default.
  if (lineFilter === "2" && dept === "b2g") return "2a";
  if (options.some((o) => o.line === lineFilter)) return lineFilter;
  return options[0].line;
}

function accentClasses(accent: string, active: boolean) {
  if (!active) return "border-white/[0.06] text-slate-400 hover:text-white hover:bg-white/5";
  const map: Record<string, string> = {
    blue: "border-blue-500/30 bg-blue-500/15 text-blue-200 shadow-md shadow-blue-500/10",
    violet: "border-violet-500/30 bg-violet-500/15 text-violet-200 shadow-md shadow-violet-500/10",
    emerald: "border-emerald-500/30 bg-emerald-500/15 text-emerald-200 shadow-md shadow-emerald-500/10",
    pink: "border-pink-500/30 bg-pink-500/15 text-pink-200 shadow-md shadow-pink-500/10",
  };
  return map[accent] ?? map.blue;
}

// ─── Kind styling (same visual language as OKK scoring cards) ──────

interface KindStyle {
  rowBg: string;        // subtle tint on the row body
  border: string;       // outer border color
  accentBar: string;    // legacy, unused (kept for backwards compat of type)
  labelText: string;    // label color
  labelBg: string;      // label chip bg
  titleColor: string;   // title text
  fieldBg: string;      // tinted input background
  fieldBorder: string;  // tinted input border
  fieldFocus: string;   // focus ring color
  quoteBar: string;     // thin vertical bar next to the script textarea
  icon: typeof FileText;
  label: string;
}

function getKindStyle(kind: ItemKind): KindStyle {
  switch (kind) {
    case "section":
      return {
        rowBg: "bg-blue-500/[0.10]",
        border: "border-blue-500/20",
        accentBar: "",
        labelText: "text-blue-300",
        labelBg: "bg-blue-500/20 border border-blue-500/30",
        titleColor: "text-white",
        fieldBg: "bg-blue-500/10",
        fieldBorder: "border-blue-500/25",
        fieldFocus: "focus:border-blue-400/60 focus:ring-blue-500/20",
        quoteBar: "bg-blue-400/40",
        icon: Sparkles,
        label: "Раздел",
      };
    case "subheader":
      return {
        rowBg: "bg-slate-500/[0.10]",
        border: "border-white/[0.06]",
        accentBar: "",
        labelText: "text-slate-300",
        labelBg: "bg-slate-500/20 border border-slate-400/25",
        titleColor: "text-slate-100",
        fieldBg: "bg-slate-500/10",
        fieldBorder: "border-slate-400/20",
        fieldFocus: "focus:border-slate-300/40 focus:ring-slate-400/20",
        quoteBar: "bg-slate-400/40",
        icon: BookOpen,
        label: "Подраздел",
      };
    case "objection":
      return {
        rowBg: "bg-rose-500/[0.10]",
        border: "border-rose-500/20",
        accentBar: "",
        labelText: "text-rose-300",
        labelBg: "bg-rose-500/20 border border-rose-500/30",
        titleColor: "text-rose-50",
        fieldBg: "bg-rose-500/10",
        fieldBorder: "border-rose-500/25",
        fieldFocus: "focus:border-rose-400/60 focus:ring-rose-500/20",
        quoteBar: "bg-rose-400/40",
        icon: ShieldAlert,
        label: "Возражение",
      };
    case "note":
      return {
        rowBg: "bg-amber-500/[0.10]",
        border: "border-amber-500/20",
        accentBar: "",
        labelText: "text-amber-300",
        labelBg: "bg-amber-500/20 border border-amber-500/30",
        titleColor: "text-amber-50",
        fieldBg: "bg-amber-500/10",
        fieldBorder: "border-amber-500/25",
        fieldFocus: "focus:border-amber-400/60 focus:ring-amber-500/20",
        quoteBar: "bg-amber-400/40",
        icon: MessageSquare,
        label: "Заметка",
      };
    case "item":
    default:
      return {
        rowBg: "bg-emerald-500/[0.06]",
        border: "border-white/[0.06]",
        accentBar: "",
        labelText: "text-emerald-300",
        labelBg: "bg-emerald-500/15 border border-emerald-500/25",
        titleColor: "text-white",
        fieldBg: "bg-emerald-500/[0.08]",
        fieldBorder: "border-emerald-500/20",
        fieldFocus: "focus:border-emerald-400/50 focus:ring-emerald-500/20",
        quoteBar: "bg-emerald-400/40",
        icon: Headphones,
        label: "Реплика",
      };
  }
}

// ─── Item Card ──────────────────────────────────────────────────

interface ItemCardProps {
  item: ScriptItem;
  index: number;
  readOnly: boolean;
  onChange: (field: keyof ScriptItem, value: unknown) => void;
  onDelete: () => void;
}

function ItemCard({ item, index, readOnly, onChange, onDelete }: ItemCardProps) {
  const style = getKindStyle(item.kind);
  const Icon = style.icon;
  const isSection = item.kind === "section";
  const isHeaderOnly = item.kind === "subheader";
  const isNote = item.kind === "note";

  return (
    <div className={`relative ${style.rowBg} ${index > 0 ? "border-t border-white/[0.04]" : ""}`}>
      <div className="px-5 py-4 space-y-3">
        {/* Top row: #id + label chip + kind selector + delete */}
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[10px] text-slate-500 font-mono shrink-0">#{index + 1}</span>
          <div className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md ${style.labelBg}`}>
            <Icon className={`w-3 h-3 ${style.labelText}`} />
            <span className={`text-[10px] font-semibold uppercase tracking-wider ${style.labelText}`}>
              {style.label}
            </span>
          </div>
          {!readOnly && (
            <>
              <select
                value={item.kind}
                onChange={(e) => onChange("kind", e.target.value as ItemKind)}
                className="text-[10px] bg-slate-800/60 border border-white/[0.06] rounded px-1.5 py-0.5 text-slate-400 focus:outline-none focus:border-blue-500/40 cursor-pointer hover:border-white/20 transition-colors"
              >
                <option value="item">Реплика</option>
                <option value="section">Раздел</option>
                <option value="subheader">Подраздел</option>
                <option value="objection">Возражение</option>
                <option value="note">Заметка</option>
              </select>
              <button
                type="button"
                onClick={onDelete}
                aria-label="Удалить блок"
                className="ml-auto p-1 rounded text-slate-500 hover:text-rose-400 hover:bg-rose-500/10 transition-colors"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </>
          )}
        </div>

        {/* Title */}
        {!isNote && (
          <input
            type="text"
            value={item.title ?? ""}
            onChange={(e) => onChange("title", e.target.value)}
            readOnly={readOnly}
            placeholder={isSection ? "Название раздела" : "Заголовок блока"}
            className={`w-full ${style.fieldBg} border ${style.fieldBorder} ${style.fieldFocus} focus:ring-2 rounded-lg px-3 py-2 font-semibold focus:outline-none placeholder-slate-500 transition ${
              isSection ? "text-sm uppercase tracking-wide" : "text-sm"
            } ${style.titleColor} ${readOnly ? "cursor-default" : ""}`}
          />
        )}

        {/* Script body (не показываем у subheader и section без текста) */}
        {!isHeaderOnly && !isNote && (item.script || !readOnly || isSection) && (
          <div className="flex gap-2.5">
            <div className={`w-[2px] rounded-full ${style.quoteBar} shrink-0 mt-1`} />
            <textarea
              value={item.script ?? ""}
              onChange={(e) => onChange("script", e.target.value)}
              readOnly={readOnly}
              rows={Math.max(2, Math.min(20, Math.ceil((item.script?.length ?? 0) / 90) + 1))}
              placeholder={isSection ? "Описание раздела (необязательно)..." : "Что говорит менеджер..."}
              className={`flex-1 ${style.fieldBg} border ${style.fieldBorder} ${style.fieldFocus} focus:ring-2 rounded-lg px-3 py-2.5 text-[13px] leading-relaxed focus:outline-none resize-y placeholder-slate-500 transition ${
                isSection ? "text-slate-200" : "text-slate-100"
              } ${readOnly ? "cursor-default" : ""}`}
            />
          </div>
        )}

        {/* Note body */}
        {isNote && (
          <textarea
            value={item.note ?? item.title ?? ""}
            onChange={(e) => onChange("note", e.target.value)}
            readOnly={readOnly}
            rows={Math.max(2, Math.min(10, Math.ceil(((item.note ?? item.title) ?? "").length / 90) + 1))}
            placeholder="Важная заметка..."
            className={`w-full ${style.fieldBg} border ${style.fieldBorder} ${style.fieldFocus} focus:ring-2 rounded-lg px-3 py-2.5 text-[12.5px] text-amber-100 italic leading-relaxed focus:outline-none resize-y placeholder-amber-300/40 transition ${
              readOnly ? "cursor-default" : ""
            }`}
          />
        )}

        {/* Comment — что нужно знать (amber always) */}
        {!isNote && !isHeaderOnly && (item.comment || !readOnly) && (
          <div>
            <div className="flex items-center gap-1.5 text-[10px] font-bold text-amber-300 uppercase tracking-wider mb-1">
              <MessageSquare className="w-3 h-3" />
              Что нужно знать менеджеру
            </div>
            <textarea
              value={item.comment ?? ""}
              onChange={(e) => onChange("comment", e.target.value)}
              readOnly={readOnly}
              rows={Math.max(2, Math.min(10, Math.ceil((item.comment?.length ?? 0) / 90) + 1))}
              placeholder="Пояснение, контекст, что важно учитывать..."
              className={`w-full bg-amber-500/[0.08] border border-amber-500/20 rounded-lg px-3 py-2 text-[12px] text-amber-100 leading-relaxed focus:border-amber-400/50 focus:ring-2 focus:ring-amber-500/20 focus:outline-none resize-y placeholder-amber-300/30 transition ${
                readOnly ? "cursor-default" : ""
              }`}
            />
          </div>
        )}

        {/* Tips — cyan always */}
        {!isNote && (item.tips || (!readOnly && !isSection && !isHeaderOnly)) && (
          <div>
            <div className="flex items-center gap-1.5 text-[10px] font-bold text-cyan-300 uppercase tracking-wider mb-1">
              <Sparkles className="w-3 h-3" />
              Подсказки
            </div>
            <textarea
              value={item.tips ?? ""}
              onChange={(e) => onChange("tips", e.target.value)}
              readOnly={readOnly}
              rows={2}
              placeholder="Дополнительные подсказки..."
              className={`w-full bg-cyan-500/[0.08] border border-cyan-500/20 rounded-lg px-3 py-2 text-[12px] text-cyan-100 leading-relaxed focus:border-cyan-400/50 focus:ring-2 focus:ring-cyan-500/20 focus:outline-none resize-y placeholder-cyan-300/30 transition ${
                readOnly ? "cursor-default" : ""
              }`}
            />
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Section Block ──────────────────────────────────────────────

interface SectionBlockProps {
  section: ScriptSection;
  readOnly: boolean;
  sectionIdx: number;
  hasMultipleSections: boolean;
  onItemChange: (itemIdx: number, field: keyof ScriptItem, value: unknown) => void;
  onItemDelete: (itemIdx: number) => void;
  onItemAdd: () => void;
  onSectionTitleChange: (title: string) => void;
}

function SectionBlock({
  section,
  readOnly,
  sectionIdx,
  hasMultipleSections,
  onItemChange,
  onItemDelete,
  onItemAdd,
  onSectionTitleChange,
}: SectionBlockProps) {
  const [open, setOpen] = useState(true);

  return (
    <div className="rounded-xl border border-blue-500/20 bg-slate-900/30 overflow-hidden">
      {hasMultipleSections && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="w-full flex items-center justify-between px-5 py-3.5 text-left hover:bg-white/[0.02] transition-colors"
          aria-expanded={open}
        >
          <div className="flex items-center gap-3 min-w-0 flex-1">
            <ChevronDown
              className={`w-4 h-4 shrink-0 text-blue-400 transition-transform duration-200 ${open ? "" : "-rotate-90"}`}
            />
            {readOnly ? (
              <span className="text-sm font-bold text-white truncate">{section.title ?? "Раздел"}</span>
            ) : (
              <input
                type="text"
                value={section.title ?? ""}
                onChange={(e) => onSectionTitleChange(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                placeholder="Название раздела"
                className="flex-1 bg-transparent text-sm font-bold text-white focus:outline-none placeholder-slate-500"
              />
            )}
          </div>
          <span className="text-[11px] text-blue-400 bg-blue-500/10 px-2.5 py-1 rounded-lg border border-blue-500/20 font-medium shrink-0 ml-3">
            {section.items.length} блоков
          </span>
        </button>
      )}

      {open && (
        <div className={`${hasMultipleSections ? "border-t border-white/[0.04]" : ""}`}>
          {section.items.length === 0 ? (
            <div className="text-center py-10 text-sm text-slate-500">
              В этом разделе пока нет блоков.
            </div>
          ) : (
            section.items.map((item, idx) => (
              <ItemCard
                key={item.id}
                item={item}
                index={idx}
                readOnly={readOnly}
                onChange={(field, value) => onItemChange(idx, field, value)}
                onDelete={() => onItemDelete(idx)}
              />
            ))
          )}
          {!readOnly && (
            <div className="px-5 py-3 border-t border-white/[0.04]">
              <button
                type="button"
                onClick={onItemAdd}
                className="w-full flex items-center justify-center gap-2 py-2 rounded-lg border border-dashed border-white/[0.08] text-slate-500 hover:text-blue-400 hover:border-blue-500/30 hover:bg-blue-500/[0.04] transition-all text-xs font-medium"
              >
                <Plus className="w-3.5 h-3.5" />
                Добавить блок
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Main ──────────────────────────────────────────────────────

function createEmptyItem(): ScriptItem {
  return {
    id: `new-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    kind: "item",
    title: "",
    script: "",
    comment: "",
  };
}

function normalizeContent(content: unknown): ScriptContent {
  if (!content || typeof content !== "object") return { sections: [] };
  const c = content as { sections?: unknown };
  if (!Array.isArray(c.sections)) return { sections: [] };
  return {
    sections: c.sections.map((s, sIdx) => {
      const sec = s as Partial<ScriptSection> | null;
      if (!sec || typeof sec !== "object") return { id: `s${sIdx}`, title: null, items: [] };
      const items = Array.isArray(sec.items) ? sec.items : [];
      return {
        id: sec.id ?? `s${sIdx}`,
        title: sec.title ?? null,
        items: items.map((it, iIdx) => {
          const item = it as Partial<ScriptItem> | null;
          if (!item || typeof item !== "object") {
            return { id: `i-${sIdx}-${iIdx}`, kind: "item" };
          }
          return {
            id: item.id ?? `i-${sIdx}-${iIdx}`,
            kind: (item.kind ?? "item") as ItemKind,
            title: item.title,
            script: item.script,
            comment: item.comment,
            note: item.note,
            tips: item.tips,
            editor_note: item.editor_note,
          };
        }),
      };
    }),
  };
}

export default function ScriptsTab({ department, lineFilter, isAdmin }: ScriptsTabProps) {
  const options = useMemo(() => getLineOptions(department), [department]);
  const [activeLine, setActiveLine] = useState<string>(() => getDefaultLine(department, lineFilter));

  const [data, setData] = useState<ScriptData | null>(null);
  const [content, setContent] = useState<ScriptContent>({ sections: [] });
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);

  useEffect(() => {
    setActiveLine(getDefaultLine(department, lineFilter));
  }, [department, lineFilter]);

  const load = useCallback(async (dep: "b2g" | "b2b", ln: string) => {
    setLoading(true);
    setError(null);
    setDirty(false);
    setSaveSuccess(false);
    try {
      const res = await fetch(`/api/scripts?department=${dep}&line=${ln}`);
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error ?? "Ошибка загрузки");
      setData(json.data);
      setContent(normalizeContent(json.data.content));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setData(null);
      setContent({ sections: [] });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(department, activeLine);
  }, [department, activeLine, load]);

  const activeOption = options.find((o) => o.line === activeLine);
  const readOnly = !isAdmin;

  const updateItem = useCallback(
    (sIdx: number, iIdx: number, field: keyof ScriptItem, value: unknown) => {
      setContent((prev) => ({
        sections: prev.sections.map((sec, si) =>
          si !== sIdx
            ? sec
            : {
                ...sec,
                items: sec.items.map((it, ii) => (ii !== iIdx ? it : { ...it, [field]: value })),
              },
        ),
      }));
      setDirty(true);
      setSaveSuccess(false);
    },
    [],
  );

  const deleteItem = useCallback((sIdx: number, iIdx: number) => {
    if (!window.confirm("Удалить блок?")) return;
    setContent((prev) => ({
      sections: prev.sections.map((sec, si) =>
        si !== sIdx ? sec : { ...sec, items: sec.items.filter((_, ii) => ii !== iIdx) },
      ),
    }));
    setDirty(true);
    setSaveSuccess(false);
  }, []);

  const addItem = useCallback((sIdx: number) => {
    setContent((prev) => ({
      sections: prev.sections.map((sec, si) =>
        si !== sIdx ? sec : { ...sec, items: [...sec.items, createEmptyItem()] },
      ),
    }));
    setDirty(true);
    setSaveSuccess(false);
  }, []);

  const updateSectionTitle = useCallback((sIdx: number, title: string) => {
    setContent((prev) => ({
      sections: prev.sections.map((sec, si) => (si !== sIdx ? sec : { ...sec, title })),
    }));
    setDirty(true);
    setSaveSuccess(false);
  }, []);

  const addSection = useCallback(() => {
    setContent((prev) => ({
      sections: [
        ...prev.sections,
        {
          id: `s-new-${Date.now()}`,
          title: "Новый раздел",
          items: [createEmptyItem()],
        },
      ],
    }));
    setDirty(true);
    setSaveSuccess(false);
  }, []);

  const handleSave = async () => {
    if (!isAdmin) return;
    setSaving(true);
    setError(null);
    setSaveSuccess(false);
    try {
      const res = await fetch("/api/scripts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          department,
          line: activeLine,
          title: data?.title ?? activeOption?.label ?? "",
          notionUrl: data?.notionUrl ?? null,
          content,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error ?? "Ошибка сохранения");
      setDirty(false);
      setSaveSuccess(true);
      setData((prev) =>
        prev
          ? {
              ...prev,
              content,
              version: json.data.version ?? prev.version + 1,
              updatedAt: json.data.updatedAt ?? new Date().toISOString(),
            }
          : prev,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const totalBlocks = content.sections.reduce((s, sec) => s + sec.items.length, 0);
  const hasMultipleSections = content.sections.length > 1;

  return (
    <div className="flex flex-col gap-5 fade-in">
      {/* Header */}
      <div className="glass-panel rounded-2xl p-6 border border-white/5 shadow-lg">
        <div className="flex items-center justify-between flex-wrap gap-3 mb-4">
          <div>
            <h2 className="text-xl font-bold text-white flex items-center gap-2">
              <FileText className="w-5 h-5 text-blue-400" />
              Скрипты продаж
            </h2>
            <p className="text-sm text-slate-400 mt-1">
              {department === "b2b" ? "Коммерсы" : "Госники"} — {activeOption?.label ?? activeLine}
            </p>
          </div>
          <div className="flex items-center gap-3">
            {data?.notionUrl && (
              <a
                href={data.notionUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-blue-300 transition-colors"
              >
                <ExternalLink className="w-3.5 h-3.5" />
                База знаний
              </a>
            )}
            {dirty && (
              <span className="text-xs text-amber-400 bg-amber-500/10 px-3 py-1.5 rounded-lg border border-amber-500/20 font-medium">
                Несохранённые изменения
              </span>
            )}
            {saveSuccess && (
              <span className="flex items-center gap-1.5 text-xs text-emerald-400 bg-emerald-500/10 px-3 py-1.5 rounded-lg border border-emerald-500/20">
                <CheckCircle2 className="w-3.5 h-3.5" /> Сохранено
              </span>
            )}
          </div>
        </div>

        {/* Line tabs */}
        <div className="flex gap-2 flex-wrap">
          {options.map((opt) => (
            <button
              type="button"
              key={opt.line}
              onClick={() => setActiveLine(opt.line)}
              className={`px-4 py-2 rounded-xl text-sm font-medium transition-all border ${accentClasses(
                opt.accent,
                activeLine === opt.line,
              )}`}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {/* Stats */}
        {!loading && data && (
          <div className="flex items-center gap-6 mt-4 pt-4 border-t border-white/[0.06] text-sm">
            <div>
              <span className="text-2xl font-bold text-white">{totalBlocks}</span>
              <span className="text-xs text-slate-500 ml-1.5">блоков</span>
            </div>
            <div>
              <span className="text-2xl font-bold text-blue-400">{content.sections.length}</span>
              <span className="text-xs text-slate-500 ml-1.5">разделов</span>
            </div>
            <div>
              <span className="text-2xl font-bold text-emerald-400">v{data.version}</span>
              <span className="text-xs text-slate-500 ml-1.5">
                {data.updatedBy ? `обновил ${data.updatedBy}` : "версия"}
              </span>
            </div>
            {data.updatedAt && (
              <div className="ml-auto text-xs text-slate-500">
                Обновлено {new Date(data.updatedAt).toLocaleString("ru-RU")}
              </div>
            )}
          </div>
        )}
      </div>

      {error && (
        <div className="flex items-center gap-2 px-5 py-4 bg-red-500/10 border border-red-500/20 rounded-xl text-red-300 text-sm">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          {error}
        </div>
      )}

      {loading && (
        <div className="flex items-center justify-center py-24">
          <Loader2 className="w-7 h-7 text-blue-400 animate-spin" />
        </div>
      )}

      {!loading && data && !data.exists && content.sections.length === 0 && (
        <div className="glass-panel rounded-2xl p-10 border border-dashed border-white/[0.08] text-center">
          <FileText className="w-10 h-10 text-slate-600 mx-auto mb-3" />
          <p className="text-slate-400 mb-4">Скрипт для этой линии ещё не создан.</p>
          {isAdmin && (
            <button
              type="button"
              onClick={addSection}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-blue-500 hover:bg-blue-600 text-white text-sm font-semibold transition-colors"
            >
              <Plus className="w-4 h-4" /> Создать первый раздел
            </button>
          )}
        </div>
      )}

      {!loading && content.sections.length > 0 && (
        <div className="flex flex-col gap-4">
          {content.sections.map((section, sIdx) => (
            <SectionBlock
              key={section.id}
              section={section}
              readOnly={readOnly}
              sectionIdx={sIdx}
              hasMultipleSections={hasMultipleSections}
              onItemChange={(iIdx, field, value) => updateItem(sIdx, iIdx, field, value)}
              onItemDelete={(iIdx) => deleteItem(sIdx, iIdx)}
              onItemAdd={() => addItem(sIdx)}
              onSectionTitleChange={(t) => updateSectionTitle(sIdx, t)}
            />
          ))}
          {isAdmin && content.sections.length > 0 && (
            <button
              type="button"
              onClick={addSection}
              className="w-full flex items-center justify-center gap-2 py-3 rounded-xl border border-dashed border-white/[0.06] text-slate-500 hover:text-blue-300 hover:border-blue-500/30 transition-all text-sm font-medium"
            >
              <Plus className="w-4 h-4" />
              Добавить новый раздел
            </button>
          )}
        </div>
      )}

      {!loading && isAdmin && (content.sections.length > 0 || dirty) && (
        <div className="flex justify-end pt-2 pb-6">
          <button
            type="button"
            onClick={handleSave}
            disabled={!dirty || saving}
            className={`flex items-center gap-2 px-8 py-3 rounded-xl text-sm font-semibold transition-all ${
              dirty
                ? "bg-blue-500 hover:bg-blue-600 text-white shadow-lg shadow-blue-500/25"
                : "bg-slate-800 text-slate-500 cursor-not-allowed"
            }`}
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            Сохранить изменения
          </button>
        </div>
      )}
    </div>
  );
}
