"use client";

import { useState, useEffect, useCallback } from "react";
import { Loader2, Plus, Trash2, Save, AlertTriangle, Calendar, Wallet } from "lucide-react";
import SchedulePopup from "@/components/SchedulePopup";
import TabelPopup from "@/components/TabelPopup";
import { getDepartment } from "@/lib/config/tenant";

interface ManagerRow {
  id?: string;
  _clientId?: string;
  name: string;
  telegramUsername: string | null;
  telegramId: string | null;
  role: string;
  line: string | null;
  kommoUserId: number | null;
  cloudtalkAgentId: string | null;
  shiftStartTime: string | null;
  // shiftEndTime is read-only here (edited via the calendar popup); kept on the
  // row so we can pass it into SchedulePopup without a second fetch.
  shiftEndTime: string | null;
  // Daily payroll rate (numeric string from drizzle, null when unset).
  dailyRate: string | null;
  inOkk: boolean;
  inRolevki: boolean;
  isNew?: boolean;
}

interface ManagersTabProps {
  department: "b2g" | "b2b";
}

export default function ManagersTab({ department }: ManagersTabProps) {
  const [managers, setManagers] = useState<ManagerRow[]>([]);
  const [deletedIds, setDeletedIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [showSchedule, setShowSchedule] = useState(false);
  // Defaults to the current calendar month — SchedulePopup has its own
  // month-shift arrows so the user can navigate freely after opening.
  const [scheduleMonth, setScheduleMonth] = useState<Date>(() => new Date());
  const [showTabel, setShowTabel] = useState(false);

  const fetchManagers = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/managers?department=${department}`);
      const json = await res.json();
      if (json.success) {
        setManagers(
          json.data.map((m: ManagerRow) => ({
            ...m,
            isNew: false,
          })),
        );
        setDeletedIds([]);
        setDirty(false);
        setWarnings([]);
        setSaveSuccess(false);
      }
    } finally {
      setLoading(false);
    }
  }, [department]);

  useEffect(() => {
    fetchManagers();
  }, [fetchManagers]);

  const updateField = (index: number, field: keyof ManagerRow, value: unknown) => {
    setManagers((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], [field]: value };
      return next;
    });
    setDirty(true);
    setSaveSuccess(false);
  };

  const addManager = () => {
    setManagers((prev) => [
      ...prev,
      {
        _clientId: crypto.randomUUID(),
        name: "",
        telegramUsername: null,
        telegramId: null,
        role: "manager",
        line: null,
        kommoUserId: null,
        cloudtalkAgentId: null,
        shiftStartTime: null,
        shiftEndTime: null,
        dailyRate: null,
        inOkk: true,
        inRolevki: true,
        isNew: true,
      },
    ]);
    setDirty(true);
    setSaveSuccess(false);
  };

  const removeManager = (index: number) => {
    const mgr = managers[index];
    if (mgr.id) {
      setDeletedIds((prev) => [...prev, mgr.id!]);
    }
    setManagers((prev) => prev.filter((_, i) => i !== index));
    setDirty(true);
    setSaveSuccess(false);
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveSuccess(false);
    setWarnings([]);
    try {
      const res = await fetch("/api/managers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          department,
          managers: managers.map((m) => ({
            id: m.id || undefined,
            name: m.name,
            telegramUsername: m.telegramUsername,
            telegramId: m.telegramId,
            kommoUserId: m.kommoUserId,
            role: m.role,
            line: m.line,
            shiftStartTime: m.shiftStartTime,
            // dailyRate intentionally NOT sent in the bulk save — that field
            // is owned by the «Табель» popup (PATCH /api/daily/managers).
            // Bulk save with dailyRate undefined preserves the stored value.
            inOkk: m.inOkk,
            inRolevki: m.inRolevki,
          })),
          deletedIds,
        }),
      });
      const text = await res.text();
      if (!text) {
        setWarnings(["Сервер вернул пустой ответ"]);
        return;
      }
      const json = JSON.parse(text);
      if (json.error) {
        setWarnings([`Ошибка: ${json.error}`]);
        return;
      }
      if (json.success) {
        setManagers(
          json.data.map((m: ManagerRow) => ({ ...m, isNew: false })),
        );
        setDeletedIds([]);
        setDirty(false);
        setSaveSuccess(true);
        if (json.warnings?.length > 0) {
          setWarnings(json.warnings);
        }
      }
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-6 h-6 animate-spin text-blue-400" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 fade-in">
      {/* Header */}
      <div className="glass-panel rounded-2xl p-5 border border-white/5 shadow-lg">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold text-white">
              Менеджеры — {getDepartment(department).label}
            </h2>
            <p className="text-xs text-slate-400 mt-1">
              Управление менеджерами. Изменения синхронизируются в ОКК и Ролевки.
            </p>
          </div>
          <div className="flex items-center gap-3">
            {dirty && (
              <span className="text-xs text-amber-400 bg-amber-500/10 px-3 py-1.5 rounded-lg border border-amber-500/20 font-medium">
                Есть несохранённые изменения
              </span>
            )}
            <button
              onClick={() => { setScheduleMonth(new Date()); setShowSchedule(true); }}
              className="flex items-center gap-1.5 text-xs uppercase tracking-wider px-3 py-1.5 rounded-lg text-purple-400 hover:text-white bg-purple-500/10 hover:bg-purple-500/20 transition-colors border border-purple-500/20 font-medium"
            >
              <Calendar className="w-3.5 h-3.5" />
              Календарь
            </button>
            <button
              onClick={() => setShowTabel(true)}
              className="flex items-center gap-1.5 text-xs uppercase tracking-wider px-3 py-1.5 rounded-lg text-emerald-400 hover:text-white bg-emerald-500/10 hover:bg-emerald-500/20 transition-colors border border-emerald-500/20 font-medium"
            >
              <Wallet className="w-3.5 h-3.5" />
              Табель
            </button>
          </div>
        </div>
      </div>

      {/* Warnings */}
      {warnings.length > 0 && (
        <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl p-4 flex flex-col gap-1">
          <div className="flex items-center gap-2 text-amber-400 text-xs font-bold">
            <AlertTriangle className="w-4 h-4" />
            Предупреждения
          </div>
          {warnings.map((w, i) => (
            <p key={i} className="text-xs text-amber-300/80 pl-6">{w}</p>
          ))}
        </div>
      )}

      {/* Success */}
      {saveSuccess && !dirty && (
        <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-xl px-4 py-3 text-xs text-emerald-400 font-medium">
          Сохранено и синхронизировано
        </div>
      )}

      {/* Single unified table */}
      <div className="glass-panel rounded-2xl border border-white/5 shadow-lg overflow-hidden">
        <div className="px-5 py-3 border-b border-white/5">
          <h3 className="text-xs font-bold text-blue-400 uppercase tracking-wider">
            Команда ({managers.length})
          </h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/5 text-[10px] uppercase tracking-wider text-slate-500">
                <th className="text-left px-4 py-2 font-semibold w-8">#</th>
                <th className="text-left px-4 py-2 font-semibold">Имя</th>
                <th className="text-left px-4 py-2 font-semibold">@Telegram</th>
                <th className="text-center px-4 py-2 font-semibold">Роль</th>
                {department === "b2g" && <th className="text-center px-4 py-2 font-semibold">Линия</th>}
                <th className="text-center px-4 py-2 font-semibold">ОКК</th>
                <th className="text-center px-4 py-2 font-semibold">Ролевки</th>
                <th className="text-center px-4 py-2 font-semibold text-slate-600">TG ID</th>
                <th className="text-center px-4 py-2 font-semibold text-slate-600">Kommo ID</th>
                <th className="text-center px-4 py-2 font-semibold text-slate-600">CloudTalk ID</th>
                <th className="w-10" />
              </tr>
            </thead>
            <tbody>
              {managers.map((mgr, i) => {
                const isRop = mgr.role === "rop";
                const isTeamlead = mgr.role === "teamlead";
                const hasNoTelegramId = mgr.inRolevki && !mgr.telegramId && mgr.telegramUsername;
                const inputClass =
                  "bg-transparent border border-white/10 rounded-lg px-3 py-1.5 text-sm text-slate-200 focus:border-blue-500/50 focus:outline-none transition-colors w-full placeholder-slate-600";

                return (
                  <tr
                    key={mgr.id ?? mgr._clientId ?? `row-${i}`}
                    className={`border-b border-white/5 hover:bg-white/[0.02] transition-colors ${mgr.isNew ? "bg-blue-500/5" : ""} ${isRop ? "bg-amber-500/[0.03]" : ""} ${isTeamlead ? "bg-emerald-500/[0.03]" : ""}`}
                  >
                    <td className="px-4 py-2 text-xs text-slate-500 font-mono">{i + 1}</td>
                    <td className="px-4 py-2">
                      <input
                        type="text"
                        value={mgr.name}
                        onChange={(e) => updateField(i, "name", e.target.value)}
                        placeholder="Имя Фамилия"
                        className={inputClass}
                      />
                    </td>
                    <td className="px-4 py-2">
                      <div className="relative">
                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 text-sm">@</span>
                        <input
                          type="text"
                          value={mgr.telegramUsername || ""}
                          onChange={(e) => updateField(i, "telegramUsername", e.target.value || null)}
                          placeholder="username"
                          className={`${inputClass} pl-7`}
                        />
                      </div>
                    </td>
                    <td className="px-4 py-2 text-center">
                      <select
                        value={mgr.role || "manager"}
                        onChange={(e) => updateField(i, "role", e.target.value)}
                        className={`bg-slate-800 border rounded-lg px-2 py-1.5 text-sm focus:border-blue-500/50 focus:outline-none cursor-pointer ${
                          isRop
                            ? "border-amber-500/30 text-amber-400"
                            : isTeamlead
                              ? "border-emerald-500/30 text-emerald-400"
                              : "border-white/10 text-slate-200"
                        }`}
                      >
                        <option value="manager">Менеджер</option>
                        <option value="teamlead">Тимлид</option>
                        <option value="rop">РОП</option>
                        {/* Менеджер продлений (не МОП): все продажные выборки
                            (Звонки/Дейли/Активность/ОКК) — белые списки ролей
                            manager/teamlead/rop, поэтому эта роль выводит
                            человека из подсчётов, сохраняя историю звонков. */}
                        <option value="prolongation">Продления</option>
                      </select>
                    </td>
                    {department === "b2g" && (
                      <td className="px-4 py-2 text-center">
                        <select
                          value={mgr.line || ""}
                          onChange={(e) => updateField(i, "line", e.target.value || null)}
                          className="bg-slate-800 border border-white/10 rounded-lg px-2 py-1.5 text-sm text-slate-200 focus:border-blue-500/50 focus:outline-none cursor-pointer"
                        >
                          <option value="">—</option>
                          <option value="1">1я</option>
                          <option value="2">2я</option>
                          <option value="3">3я</option>
                        </select>
                      </td>
                    )}
                    <td className="px-4 py-2 text-center">
                      <input
                        type="checkbox"
                        checked={mgr.inOkk}
                        onChange={(e) => updateField(i, "inOkk", e.target.checked)}
                        className="w-4 h-4 rounded border-white/20 bg-slate-800 text-blue-500 focus:ring-blue-500/50 cursor-pointer accent-blue-500"
                      />
                    </td>
                    <td className="px-4 py-2 text-center">
                      <input
                        type="checkbox"
                        checked={mgr.inRolevki}
                        onChange={(e) => updateField(i, "inRolevki", e.target.checked)}
                        className="w-4 h-4 rounded border-white/20 bg-slate-800 text-blue-500 focus:ring-blue-500/50 cursor-pointer accent-blue-500"
                      />
                    </td>
                    <td className="px-4 py-2 text-center">
                      <span className={`text-xs font-mono ${hasNoTelegramId ? "text-amber-400" : "text-slate-600"}`}>
                        {mgr.telegramId && !["100001", "100002", "100003"].includes(mgr.telegramId)
                          ? mgr.telegramId
                          : hasNoTelegramId
                            ? "⚠️"
                            : "—"}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-center">
                      <span className={`text-xs font-mono ${mgr.kommoUserId ? "text-slate-400" : mgr.inOkk ? "text-amber-400" : "text-slate-600"}`}>
                        {mgr.kommoUserId || (mgr.inOkk ? "⏳" : "—")}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-center">
                      <span className={`text-xs font-mono ${mgr.cloudtalkAgentId ? "text-slate-400" : "text-slate-600"}`}>
                        {mgr.cloudtalkAgentId || "—"}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-center">
                      <button
                        onClick={() => removeManager(i)}
                        className="p-1.5 rounded-lg text-slate-600 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                        title="Удалить"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Add + Save buttons */}
        <div className="px-5 py-4 border-t border-white/5 flex items-center justify-between">
          <button
            onClick={addManager}
            className="flex items-center gap-2 text-xs text-blue-400 hover:text-blue-300 transition-colors px-3 py-2 rounded-lg hover:bg-blue-500/10"
          >
            <Plus className="w-4 h-4" />
            Добавить менеджера
          </button>

          <button
            onClick={handleSave}
            disabled={!dirty || saving}
            className={`flex items-center gap-2 px-6 py-2.5 rounded-xl text-sm font-semibold transition-all ${
              dirty
                ? "bg-gradient-to-r from-blue-500 to-cyan-500 text-white shadow-lg hover:shadow-blue-500/25"
                : "bg-slate-800 text-slate-500 cursor-not-allowed"
            }`}
          >
            {saving ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Save className="w-4 h-4" />
            )}
            {saving ? "Сохранение..." : "Сохранить"}
          </button>
        </div>
      </div>

      {/* Schedule popup — opens with current calendar list, edits go straight
          to manager_schedule and reload happens via onSaved. */}
      <SchedulePopup
        isOpen={showSchedule}
        onClose={() => setShowSchedule(false)}
        month={scheduleMonth}
        department={department}
        managers={managers
          .filter((m) => !!m.id)
          .map((m) => ({
            id: m.id as string,
            name: m.name,
            line: m.line,
            shiftStartTime: m.shiftStartTime,
            shiftEndTime: m.shiftEndTime,
          }))}
        onSaved={() => { setShowSchedule(false); fetchManagers(); }}
      />

      <TabelPopup
        isOpen={showTabel}
        onClose={() => setShowTabel(false)}
        department={department}
      />
    </div>
  );
}
