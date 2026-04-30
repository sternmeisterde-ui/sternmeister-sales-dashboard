# Dashboard → «Аналитика» — как работает

Last updated: 2026-04-30

Сводный отчёт по AI-оценкам — по периодам (день/неделя/месяц), по блокам, критериям и менеджерам. Два источника: `okk` (реальные звонки) и `roleplay` (AI-роле­вки). Admin-only.

## Источники данных

Зависит от селектора `source`:

### Source = `okk` (реальные звонки)

OKK-база выбранного отдела:

| DB connection | Таблица | Зачем нужна тут | Ключевые колонки |
|---|---|---|---|
| **D2** (B2G) / **R2** (B2B) | `calls` | Время звонка, для бакетинга по периодам | `id`, `call_created_at` (Berlin civil-day bucketing) |
| **D2** / **R2** | `evaluations` | Оценка с разбивкой по блокам/критериям | `call_id` (inner join на `calls.id`), `manager_id`, `prompt_type`, `total_score`, `evaluation_json` (структура с `blocks[].criteria[]`) |
| **D2** / **R2** | `managers` | Имена для drilldown'а | `id`, `name`, `is_active`, `role` (включаются `'manager'` И `'rop'`) |

### Source = `roleplay` (AI-роле­вки)

Roleplay-база выбранного отдела:

| DB connection | Таблица | Зачем нужна тут | Ключевые колонки |
|---|---|---|---|
| **D1** (B2G) / **R1** (B2B) | `d1_calls` / `r1_calls` | Роле­вой звонок, время + оценка | `id`, `user_id`, `started_at` (bucketing), `score`, `evaluation_json`, `call_type` (используется как «funnel-label» в режиме `line=all`) |
| **D1** / **R1** | `d1_users` / `r1_users` | Имена менеджеров | `id`, `name`, `is_active`, `role` (`'manager'` + `'rop'`) |

### Файловые данные

| Источник | Путь | Зачем |
|---|---|---|
| **FS** | `src/criteria/<prompt_type>.json` | «Канонические» имена блоков + порядок критериев — определяет колонки в отчёте. См. `DASHBOARD-KRITERII.md` |
| **In-memory cache** | TTL 2 мин (`src/lib/kommo/cache.ts` — общий пул кеша) | Снижает нагрузку при кликании period/groupBy |

## Layout

1. **Filters bar** (top): source toggle (OKK / Ролевки), line pills (`Все` / `1` / `2` / `3` / `2a`/`2b`...), period selector (день/неделя/месяц), manager dropdown, дата range, опциональный compare-mode (две даты)
2. **Overall scores by period** — горизонтальная heatmap-строка: один период = одна колонка, цвет по среднему баллу
3. **Blocks × periods** — таблица: строка = блок, колонки = периоды, ячейка = средний балл по блоку. Раскрывается → критерии внутри блока
4. **Per-manager breakdown** — та же структура per-manager: строка = менеджер, колонки = блоки, ячейка = средний балл. `(уволен)` в имени для inactive юзеров, у которых были оценённые звонки в окне
5. **«Без менеджера»** строка — синтетический бакет для звонков без manager_id (баг-кейс, реконсилиация totals)

## Ключевые особенности

- **Berlin civil-day bucketing**: ключ периода = Berlin civil дата звонка, не UTC. Звонок 23:30 Berlin и 00:30 Berlin следующего дня — разные дни даже если они в часе друг от друга по UTC.
- **`line=all` mode** (cross-funnel aggregate): группировка не по блокам/критериям, а по «funnel-label» — `okkPromptType` → имя воронки или `roleplay.callType` → имя воронки. Block-criteria тогда пустые.
- **Reconciliation guarantee**: per-manager сумма звонков всегда = per-period сумме. Реализовано через двухступенчатый guard — звонок попадает в manager-bucket **только если** period-bucket его принял.
- **Excluded blocks**: не показываются `Рекомендации`, `Фильтры`, `Скоринг`, `Скоринг клиента` — это сервисные блоки, не критерии оценки.
- **Compare mode**: тот же endpoint вызывается дважды (текущее окно + сравниваемое), результаты рендерятся side-by-side с дельтами.

## API

- `GET /api/analytics?department=<>&source=<okk|roleplay>&line=<>&groupBy=<day|week|month>&from=<>&to=<>&managerId=<optional>` — admin-only. Возвращает `{ periods[], blocks[], overallScores, managers, managerBreakdown[], totalCalls, source, department }`.

## Edge cases / gotchas

- **B2G sub-lines `2a`/`2b`** не теггируются на роле­вки → при `source=roleplay` принудительно collapse'ятся в `2` перед запросом.
- **Inactive менеджеры** появляются в breakdown как «(уволен)» — нужны для совпадения per-manager и per-period сумм.
- **Cache TTL 2 мин** — после изменения критериев в разделе «Критерии» дёргается `clearCache()` чтобы новые имена блоков были видны сразу.
- Если `evaluation_json.blocks` пустой или null — звонок не считается ни в одном блоке (скип). Учитывается в `processedCount` но не в bucket'ах.

## Файлы

- UI: `src/components/AnalyticsTab.tsx`
- API: `src/app/api/analytics/route.ts` (logic), `src/app/api/analytics/data/route.ts` (?), `src/app/api/analytics/sync/`, `src/app/api/analytics/backfill/`
- Cache: `src/lib/kommo/cache.ts`
- Tenant config: `src/lib/config/tenant.ts` (`getLines`, `funnelLabelForOkk`, `funnelLabelForRoleplay`)
- Schema: `src/lib/db/schema-okk.ts`, `src/lib/db/schema-existing.ts`
- Связанные docs: `DASHBOARD-KRITERII.md` (источник имен блоков), `DASHBOARD-OKK.md`, `DASHBOARD-AI-ROLEVKI.md`
