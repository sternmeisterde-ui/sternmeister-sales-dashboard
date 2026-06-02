"use client";

import { useRef, useState } from "react";
import { createPortal } from "react-dom";

interface Props {
  /** Текст подсказки. */
  label: string;
  /** Что обёртывать (бейдж, ячейка, иконка). */
  children: React.ReactNode;
  /** Подсветка cursor:help, по умолчанию on. */
  cursorHelp?: boolean;
}

/**
 * Кастомная hover-плашка в стиле основного дашборда.
 * Рендерится через portal в body — не клипится overflow-родителей.
 */
export default function HoverTip({
  label,
  children,
  cursorHelp = true,
}: Props) {
  const [hover, setHover] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const targetRef = useRef<HTMLSpanElement>(null);

  const handleEnter = () => {
    if (!targetRef.current) return;
    const rect = targetRef.current.getBoundingClientRect();
    setPos({
      left: rect.left + rect.width / 2,
      top: rect.top - 6,
    });
    setHover(true);
  };
  const handleLeave = () => setHover(false);

  return (
    <>
      <span
        ref={targetRef}
        onMouseEnter={handleEnter}
        onMouseLeave={handleLeave}
        onFocus={handleEnter}
        onBlur={handleLeave}
        className={`inline-block ${cursorHelp ? "cursor-help" : ""}`}
      >
        {children}
      </span>
      {hover &&
        pos &&
        createPortal(
          <div
            style={{
              position: "fixed",
              left: pos.left,
              top: pos.top,
              transform: "translate(-50%, -100%)",
              background: "#0f172a",
              border: "1px solid rgba(255,255,255,0.1)",
              borderRadius: 6,
              fontSize: 11,
              padding: "4px 8px",
              color: "#cbd5e1",
              boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
              whiteSpace: "nowrap",
              pointerEvents: "none",
              zIndex: 1000,
            }}
          >
            {label}
          </div>,
          document.body
        )}
    </>
  );
}
