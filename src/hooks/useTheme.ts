"use client";

import { useCallback, useEffect, useState } from "react";

export type Theme = "dark" | "light";

const STORAGE_KEY = "sm_theme";
const THEME_CLASS_LIGHT = "theme-light";
// Dark is the default — no class needed, CSS defaults match the existing
// dark palette so unchanged components look identical.

function readStoredTheme(): Theme | null {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem(STORAGE_KEY);
  return raw === "light" || raw === "dark" ? raw : null;
}

function readSystemTheme(): Theme {
  if (typeof window === "undefined") return "dark";
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function applyTheme(theme: Theme) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (theme === "light") root.classList.add(THEME_CLASS_LIGHT);
  else root.classList.remove(THEME_CLASS_LIGHT);
}

/**
 * Theme switcher. Default is dark (matches historical behaviour). Light mode
 * works by toggling a class on <html> — the CSS in globals.css overrides the
 * common dark classes (bg-slate-*, text-white, border-white/*, glass-panel)
 * via compound selectors, so existing components don't need per-class
 * migrations.
 *
 * First render SHOULD match whatever the no-flash inline script in
 * layout.tsx already set on <html>. This hook merely mirrors that into React
 * state so the toggle UI can render correctly. Do not call `applyTheme` in
 * the initial effect unless the stored value drifted away from what the
 * script detected.
 */
export function useTheme(): { theme: Theme; toggleTheme: () => void; setTheme: (t: Theme) => void } {
  const [theme, setThemeState] = useState<Theme>("dark");

  useEffect(() => {
    const stored = readStoredTheme();
    const initial = stored ?? readSystemTheme();
    setThemeState(initial);
    applyTheme(initial);
  }, []);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    applyTheme(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* private mode, ignore */
    }
  }, []);

  const toggleTheme = useCallback(() => {
    setThemeState((prev) => {
      const next = prev === "dark" ? "light" : "dark";
      applyTheme(next);
      try {
        localStorage.setItem(STORAGE_KEY, next);
      } catch {
        /* private mode, ignore */
      }
      return next;
    });
  }, []);

  return { theme, toggleTheme, setTheme };
}
