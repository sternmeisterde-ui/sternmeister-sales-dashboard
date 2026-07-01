/**
 * TENANT CONFIG — the single file to edit when rolling this dashboard out
 * for a different client.
 *
 * Anything client-specific (department labels, pipeline names, prompt types
 * bound to evaluation criteria, CRM domain, brand URLs) lives here. Business
 * logic everywhere else should read from this module instead of literal
 * strings — `grep "sternmeister"` and `grep '"buh1"'` outside this file
 * should return zero matches in steady state.
 *
 * ## Adding a new line under an existing department
 *
 *   1. Append an entry to `b2b` or `b2g` in LINES below (id, label, accent,
 *      promptType).
 *   2. Drop a new `src/criteria/<promptType>.json` file.
 *   3. Allow the new id in `VALID_LINES_*` in `src/app/api/scripts/route.ts`
 *      — that is the only other file that gatekeeps line ids.
 *   4. Restart dev server. The Scripts/Criteria tabs pick the new line up
 *      automatically; OKK calls filter by it via `promptTypeForLine()`.
 *
 * ## Swapping to a different tenant (different company)
 *
 *   Rewrite the constants at the top of this file (BRAND, KOMMO, ROLEPLAY_*)
 *   and the DEPARTMENTS + LINES tables. Replace the JSONs in `src/criteria/`.
 *   Update DB seed for `scripts` table via `scripts/seed-scripts.mjs`.
 */

// ─── Brand / host identifiers ────────────────────────────────────

export const BRAND = {
  name: "Sternmeister",
  // Cookie namespace — keeping it tenant-specific prevents collision when
  // multiple instances run behind the same load balancer or domain.
  sessionCookieName: "sm_session",
} as const;

export const KOMMO = {
  // Kommo subdomain — used both for raw API calls and to validate URLs we
  // accept from users (security gate: we only fetch from our own Kommo).
  subdomain: process.env.KOMMO_SUBDOMAIN ?? "sternmeister",
  get host(): string {
    return `${this.subdomain}.kommo.com`;
  },
  get apiBaseUrl(): string {
    return `https://${this.host}/api/v4`;
  },
} as const;

/**
 * Backend URLs for audio playback. Each roleplay instance exposes a read-only
 * media endpoint; in prod we proxy through it with a signed URL.
 */
export const ROLEPLAY_AUDIO_URLS = {
  b2g: process.env.D1_API_URL ?? "https://roleplay2.sternmeister.online",
  b2b: process.env.R1_API_URL ?? "https://roleplay1.sternmeister.online",
} as const;

// ─── Departments ─────────────────────────────────────────────────

export type DepartmentId = "b2g" | "b2b";

export interface DepartmentConfig {
  id: DepartmentId;
  /** UI label for the department toggle. */
  label: string;
  /** Short/alt label used in sub-headings. */
  shortLabel: string;
  /** Team slug stored on master_managers.team. Must match DB values. */
  team: string;
  /** Which roleplay audio URL this department's calls play from. */
  audioBaseUrl: string;
}

export const DEPARTMENTS: Record<DepartmentId, DepartmentConfig> = {
  b2g: {
    id: "b2g",
    label: "Госники (B2G)",
    shortLabel: "Госники",
    team: "dima",
    audioBaseUrl: ROLEPLAY_AUDIO_URLS.b2g,
  },
  b2b: {
    id: "b2b",
    label: "Коммерсы (B2C)",
    shortLabel: "Коммерсы",
    team: "ruzanna",
    audioBaseUrl: ROLEPLAY_AUDIO_URLS.b2b,
  },
} as const;

export function getDepartment(id: DepartmentId): DepartmentConfig {
  return DEPARTMENTS[id];
}

// ─── Lines (funnels) per department ──────────────────────────────

/**
 * Tailwind accent palette — keep to a small set so theme-switcher work stays
 * bounded. Each value must map to classes defined in `accentClasses()` at
 * each consumer site (Scripts tab, filter pills, etc).
 */
export type LineAccent = "blue" | "violet" | "pink" | "emerald" | "amber" | "rose";

export interface LineConfig {
  /** Stable slug — used as URL/query param and DB key. Never rename. */
  id: string;
  /** Primary label shown in filter pills and selectors. */
  label: string;
  /** Shorter label for compact UIs (e.g. Daily tab). Optional — falls back to label. */
  shortLabel?: string;
  /** Which evaluation criteria config (src/criteria/*.json) this line uses. */
  promptType: string;
  /** Visual accent. */
  accent: LineAccent;
  /**
   * Logical line group for Daily/Analytics aggregations. Multiple `id`s can
   * belong to the same `group` — e.g. Бератер 1 and Бератер 2 are both
   * group="2" in B2G. Use `id` for per-line filters, `group` for summaries.
   */
  group: string;
  /**
   * Бизнес-вертикаль внутри отдела (Бух/Мед). Задаётся только у b2g, чтобы
   * фильтр линий Аналитики можно было делить тумблером Бух/Мед (как в Звонках).
   * Отсутствие поля = «не мед» → getLines() по умолчанию НЕ показывает такие
   * линии в чужих вкладках (Скрипты/Критерии/ролевки остаются бух-онли).
   * b2b поле не использует (там медицина слита в общий список линий).
   * См. dev_docs/specs/21-МЕД-АДМИН-В-B2G.md.
   */
  vertical?: "buh" | "med";
}

export const LINES: Record<DepartmentId, readonly LineConfig[]> = {
  b2g: [
    { id: "1",  group: "1", vertical: "buh", label: "Линия 1 — Квалификатор",             shortLabel: "Квалификатор",  promptType: "d2_qualifier", accent: "blue" },
    { id: "2a", group: "2", vertical: "buh", label: "Линия 2 — Бератер 1 (Верх воронки)", shortLabel: "Бератер 1",     promptType: "d2_berater",   accent: "violet" },
    { id: "2b", group: "2", vertical: "buh", label: "Линия 2 — Бератер 2 (Низ воронки)",  shortLabel: "Бератер 2",     promptType: "d2_berater2",  accent: "pink" },
    { id: "3",  group: "3", vertical: "buh", label: "Линия 3 — Доведение",                shortLabel: "Доведение",     promptType: "d2_dovedenie", accent: "emerald" },
    // Мед админ (Praxisempfang) — зеркало бух-линий по медицинской воронке.
    // promptType совпадает с ОКК (d2_med_*); критерии в src/criteria/d2_med_*.json.
    { id: "med1",  group: "med1", vertical: "med", label: "Мед — Квалификатор",  shortLabel: "Мед Квал",  promptType: "d2_med_qualifier", accent: "amber" },
    { id: "med2a", group: "med2", vertical: "med", label: "Мед — Бератер 1",     shortLabel: "Мед Бер 1", promptType: "d2_med_berater",  accent: "violet" },
    { id: "med2b", group: "med2", vertical: "med", label: "Мед — Бератер 2",     shortLabel: "Мед Бер 2", promptType: "d2_med_berater2", accent: "pink" },
    { id: "med3",  group: "med3", vertical: "med", label: "Мед — Доведение",     shortLabel: "Мед Довед", promptType: "d2_med_dovedenie", accent: "emerald" },
  ],
  b2b: [
    { id: "buh1", group: "buh1", label: "Бух 1 — Первичное касание", shortLabel: "Бух 1", promptType: "r2_commercial",     accent: "emerald" },
    { id: "buh2", group: "buh2", label: "Бух 2 — Вторичное касание", shortLabel: "Бух 2", promptType: "r2_decisions",      accent: "violet" },
    { id: "med1", group: "med1", label: "Мед 1 — Medical Admin",     shortLabel: "Мед 1", promptType: "r2_med_commercial", accent: "pink" },
  ],
} as const;

/**
 * Линии отдела. Без `vertical` → бух-совместимый список (скрывает мед-линии b2g)
 * — обратная совместимость для всех существующих потребителей. С `vertical`:
 *   "buh" → бух-линии (и линии без поля), "med" → только мед, "all" → все.
 */
export function getLines(
  dept: DepartmentId,
  vertical?: "buh" | "med" | "all",
): readonly LineConfig[] {
  if (vertical === "all") return LINES[dept];
  if (vertical === "med") return LINES[dept].filter((l) => l.vertical === "med");
  // undefined | "buh" → всё, кроме мед-линий (бух + линии без вертикали, напр. b2b)
  return LINES[dept].filter((l) => l.vertical !== "med");
}

/** prompt_type'ы линий заданной вертикали (для скоупа «Все» внутри вертикали). */
export function verticalPromptTypes(dept: DepartmentId, vertical: "buh" | "med"): string[] {
  return getLines(dept, vertical).map((l) => l.promptType);
}

export function getLine(dept: DepartmentId, id: string): LineConfig | undefined {
  return LINES[dept].find((l) => l.id === id);
}

/** Resolve a line id (e.g. "buh1", "2a") back to its prompt_type. */
export function promptTypeForLine(dept: DepartmentId, id: string): string | null {
  return getLine(dept, id)?.promptType ?? null;
}

/**
 * All prompt_types belonging to a given `group` — e.g. B2G group "2" returns
 * ["d2_berater", "d2_berater2"] because both Бератер 1 and Бератер 2 share
 * the logical line group. Used by Daily/Analytics to aggregate across sub-lines.
 */
export function groupPromptTypes(dept: DepartmentId, group: string): string[] {
  return LINES[dept].filter((l) => l.group === group).map((l) => l.promptType);
}

/** All valid line ids for a department — used for input validation. */
export function validLineIds(dept: DepartmentId): readonly string[] {
  return LINES[dept].map((l) => l.id);
}

export function isValidLineId(dept: DepartmentId, id: string): boolean {
  return validLineIds(dept).includes(id);
}

/** Every prompt_type across all departments — used by the criteria API. */
export const ALL_PROMPT_TYPES: readonly string[] = Object.values(LINES).flatMap((lines) =>
  lines.map((l) => l.promptType),
);

export function isValidPromptType(value: string): boolean {
  return ALL_PROMPT_TYPES.includes(value);
}
