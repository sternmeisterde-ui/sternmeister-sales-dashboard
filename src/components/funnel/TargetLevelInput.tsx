"use client";

interface Props {
  /** Текущее значение для выбранной конверсии (null = «не задано»). */
  value: number | null;
  onChange: (next: number | null) => void;
  /** Срабатывает на blur — для немедленного сохранения. */
  onCommit?: () => void;
  /** «Сохраняется...» / «Сохранено» / «Ошибка». */
  statusText?: string | null;
}

export default function TargetLevelInput({
  value,
  onChange,
  onCommit,
  statusText,
}: Props) {
  return (
    <label className="flex items-center gap-1.5 text-xs text-slate-400">
      <span className="uppercase tracking-widest font-semibold text-[10px]">
        Цель, %
      </span>
      <input
        type="text"
        inputMode="decimal"
        placeholder="—"
        value={value ?? ""}
        onChange={(e) => {
          const raw = e.target.value.trim();
          if (raw === "") {
            onChange(null);
            return;
          }
          // Разрешаем только цифры и одну точку/запятую.
          if (!/^\d*[.,]?\d*$/.test(raw)) return;
          const num = Number(raw.replace(",", "."));
          if (Number.isNaN(num)) return;
          onChange(Math.min(100, Math.max(0, num)));
        }}
        onBlur={onCommit}
        className="w-14 bg-slate-800/50 border border-white/10 rounded-md px-2 py-1 text-sm text-slate-100 tabular-nums text-right focus:outline-none focus:border-blue-400/40"
      />
      {statusText && (
        <span className="text-[10px] text-slate-500 italic">{statusText}</span>
      )}
    </label>
  );
}
