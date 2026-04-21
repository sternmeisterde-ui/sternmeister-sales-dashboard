# Theme switcher + deferred refactor plan

Two items parked for a dedicated follow-up session. Written down so they don't
get lost and so the next person (or next session) can pick them up without
rediscovering context.

---

## 1. Theme switcher (light/dark)

**Goal.** Add a per-user preference to flip between the current dark theme and
a new light theme (white background, black outlines, slightly-grey panels).
Semantic colours — emerald for success, rose/red for fail, amber for warning —
stay identical across themes so call-score visualisations keep their meaning.

**Default.** Dark mode (current), matching existing behaviour for all users.
Light mode opt-in via a toggle in the sidebar bottom (next to the logout
button). Preference stored in `localStorage` under `sm_theme` and synced to
`<html data-theme="light|dark">` on every mount. Fall back to
`prefers-color-scheme` when no preference is stored.

### Step 1: CSS variable system (`src/app/globals.css`)

Replace Tailwind's direct slate references with semantic tokens. Keep
emerald/rose/amber/cyan as-is — they already work on both backgrounds.

```css
:root[data-theme="dark"] {
  --color-bg:            #0f172a; /* slate-900 */
  --color-bg-elevated:   #1e293b; /* slate-800 */
  --color-bg-subtle:     rgba(255,255,255,0.04);
  --color-fg:            #f8fafc; /* slate-50 */
  --color-fg-muted:      #94a3b8; /* slate-400 */
  --color-fg-subtle:     #64748b; /* slate-500 */
  --color-border:        rgba(255,255,255,0.08);
  --color-border-strong: rgba(255,255,255,0.15);
  --glass-bg:            rgba(30, 41, 59, 0.4);
}

:root[data-theme="light"] {
  --color-bg:            #ffffff;
  --color-bg-elevated:   #f8fafc; /* slate-50 */
  --color-bg-subtle:     rgba(0,0,0,0.03);
  --color-fg:            #0f172a;
  --color-fg-muted:      #475569; /* slate-600 */
  --color-fg-subtle:     #94a3b8;
  --color-border:        rgba(0,0,0,0.12);
  --color-border-strong: rgba(0,0,0,0.25);
  --glass-bg:            rgba(248, 250, 252, 0.8);
}
```

Then update `.glass-panel` and `body` background to reference `var(--glass-bg)`
and `var(--color-bg)` respectively.

### Step 2: Tailwind → CSS-variable mapping (tailwind.config.ts)

Extend the theme so `bg-surface`, `text-fg`, `border-subtle` etc. map to the
CSS vars. This is additive — existing slate-900/slate-800 classes stay
usable during migration.

```ts
theme: {
  extend: {
    colors: {
      surface: "var(--color-bg)",
      "surface-elevated": "var(--color-bg-elevated)",
      "surface-subtle": "var(--color-bg-subtle)",
      fg: "var(--color-fg)",
      "fg-muted": "var(--color-fg-muted)",
      "fg-subtle": "var(--color-fg-subtle)",
      "border-subtle": "var(--color-border)",
      "border-strong": "var(--color-border-strong)",
    },
  },
}
```

### Step 3: Migration — components to update

Strategy: **migrate incrementally**, one section per PR. The CSS vars make it
safe to ship partial migration because unmigrated components just keep the
dark look they have now.

Priority order (biggest visual surface first):

1. `src/app/page.tsx` — sidebar + top nav + call list. Swap
   `bg-slate-900` → `bg-surface`, `text-white` → `text-fg`, etc.
2. `src/components/DashboardTab.tsx`, `DailyTab.tsx`, `AnalyticsTab.tsx` —
   KPI cards and charts.
3. `src/components/CallsChart.tsx`, `CallDetailModal` (after extraction) —
   chart axis colours via prop, not baked-in slate strings.
4. `src/components/ScriptsTab.tsx`, `CriteriaTab.tsx`, `ManagersTab.tsx` —
   form fields. Replace `bg-slate-800` with `bg-surface-elevated`, etc.
5. `src/components/CalendarPicker.tsx` — popover and buttons.

Semantic colours (emerald for ≥70%, amber for 40-70%, rose for <40%,
blue/violet/pink for line accents) **do not change** across themes.
They're already chosen to work on both light and dark.

### Step 4: Theme toggle UI

Add a single icon button in the sidebar (bottom, above "Выйти"):

```tsx
<button onClick={toggleTheme} className="...">
  {theme === "dark" ? <Sun /> : <Moon />}
</button>
```

The `useTheme` hook:

```ts
// src/hooks/useTheme.ts
export function useTheme() {
  const [theme, setTheme] = useState<"dark" | "light">("dark");

  useEffect(() => {
    const saved = localStorage.getItem("sm_theme") as "dark" | "light" | null;
    const initial =
      saved ??
      (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
    setTheme(initial);
    document.documentElement.dataset.theme = initial;
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme((prev) => {
      const next = prev === "dark" ? "light" : "dark";
      localStorage.setItem("sm_theme", next);
      document.documentElement.dataset.theme = next;
      return next;
    });
  }, []);

  return { theme, toggleTheme };
}
```

Important: read the initial theme in an early `<script>` tag in
`src/app/layout.tsx` BEFORE React hydrates, to avoid the "flash of wrong
theme" on page load:

```html
<script
  dangerouslySetInnerHTML={{
    __html: `(function(){try{var t=localStorage.getItem('sm_theme');if(!t){t=matchMedia('(prefers-color-scheme: light)').matches?'light':'dark';}document.documentElement.dataset.theme=t;}catch(e){document.documentElement.dataset.theme='dark';}})();`,
  }}
/>
```

### Step 5: Gotchas

- **Dashboard chart colors** (`recharts`) take props, not classes — grid
  stroke/axis tick colour have to be wired to the theme via `useTheme()` hook.
- **Shadow and glow effects** (`shadow-[0_0_10px_rgba(52,211,153,0.3)]`) need
  softer values on light bg; extract to CSS vars too.
- **Glass panel backdrop-blur** works on both themes but the opacity of the
  glass bg needs to be different (0.4 dark, 0.8 light) — already handled in
  the `--glass-bg` var above.
- **Audio player progress bar** uses `bg-white/10` — switch to
  `bg-surface-subtle`.

### Effort estimate

- Step 1-2 (CSS vars + Tailwind): 1 hour
- Step 3 (component migration): 1 day — ~30 components, ~5 min each for the
  straightforward ones, longer for DashboardTab/AnalyticsTab.
- Step 4 (toggle UI): 30 min
- Step 5 (gotchas): 2 hours
- Total: ~1.5 days of focused work.

---

## 2. Deferred extractions from `page.tsx`

`page.tsx` is still ~1950 lines after the audio hook extraction and tenant
config migration. Two chunks are the biggest remaining contributors.

### 2a. `<CallDetailModal />`

**Source.** `page.tsx` lines ~1289-1810 (the scoring/transcript/report modal).

**Props shape.**

```ts
interface CallDetailModalProps {
  call: ManagerCall;
  modalType: "transcript" | "scoring" | "report";
  setModalType: (t: "transcript" | "scoring" | "report") => void;
  isRealCall: boolean; // activeTab === "real_calls"
  openBlocks: Set<string>;
  toggleBlock: (id: string) => void;
  onClose: () => void;
  audio: AudioPlayerAPI; // from useAudioPlayer
  report: {
    message: string;
    setMessage: (s: string) => void;
    sending: boolean;
    sent: boolean;
    onSubmit: () => Promise<void>;
  };
}
```

**Strategy.** Move the JSX verbatim — no logic changes. Destructure props
at the top of the component. Leave the `useState` for report message /
sending / sent in `page.tsx` and pass them in; otherwise the modal would
clear the report state every time it remounts.

**Risk.** High. The modal reads `selectedCall.blocks` deeply, calls
`cleanText()` (also used elsewhere), and branches on `activeTab`. Any
missed prop or closure will silently break one of the three tabs.

**Test plan before marking done.**

- Click a real call → "AI Анализ" tab → all blocks render with scores.
- Click blocks to expand/collapse → matches prior behaviour.
- Click "Сообщить об ошибке" → type → submit → 200, confirmation shown.
- Play recording inline → progress bar updates → pause → resume.
- Switch to AI-roleplay call → scoring tab shows mistakes/recommendations.

### 2b. `<CallsTable />`

**Source.** `page.tsx` lines ~1222-1383 + the filter sidebar ~1138-1220.

**Props shape.**

```ts
interface CallsTableProps {
  calls: ManagerCall[]; // already filtered by department + period
  search: string;
  setSearch: (s: string) => void;
  scoreFilter: number;
  setScoreFilter: (n: number) => void;
  dateRange: DateRange;
  setDateRange: (r: DateRange) => void;
  crmSearchUrl: string;
  setCrmSearchUrl: (s: string) => void;
  onRowClick: (call: ManagerCall, modalType: "transcript" | "scoring") => void;
  audio: AudioPlayerAPI;
  mode: "real" | "ai"; // determines columns (score column, scoring link, etc.)
}
```

**Strategy.** Move the table rendering + inline filter controls. Keep all
`useMemo` filter computations OUTSIDE the component (in `page.tsx`) so the
component stays dumb — it just renders what you give it.

**Risk.** Medium-high. Client-side sort + filter + pagination pipeline is
in-line and subtle. Safer to do in two PRs:

  1. Move filter controls (top bar with search/date/score) to
     `<CallsTableFilters />` — low risk, no coupling with rows.
  2. Move the table rows + virtualization-ready scroll container.

### Effort estimate

- `<CallDetailModal />`: 4-6 hours including manual test pass
- `<CallsTable />`: 4 hours
- Combined with post-refactor smoke test: ~1 day

Do both only when there's a block of uninterrupted focus time — they're not
the kind of change to squeeze between other work because the surface area
for subtle regressions is large.
