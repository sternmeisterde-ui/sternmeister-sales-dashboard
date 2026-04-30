# Dashboard → «Менеджеры» — как работает

Last updated: 2026-04-30 (commits `ca4270f` → security/race fixes after review)

Operational doc for the Менеджеры tab and the two popups it now hosts —
**Календарь** (расписание смен) и **Табель** (помесячный расчёт оплаты).

Read alongside [`SESSION-HANDOFF.md`](./SESSION-HANDOFF.md) for current focus
and the project root `CLAUDE.md` for department / DB conventions.

---

## Layout

```
┌── Header ────────────────────────────────────────────────────────┐
│ Менеджеры — Госники (B2G) | Коммерсы (B2B)                       │
│ "Управление менеджерами…"                          [Календарь]   │
│                                                    [Табель]      │
└──────────────────────────────────────────────────────────────────┘

┌── Команда (N) ──────────────────────────────────────────────────┐
│ # | Имя | @Telegram | РОП | Линия* | ОКК | Ролевки               │
│   |     |           |     |        | (chk)| (chk)                │
│   |     |           |     |        | TG ID | Kommo | CloudTalk    │
└──────────────────────────────────────────────────────────────────┘
                                                  *Линия колонка — только B2G

[+ Добавить менеджера]                              [Сохранить]
```

«Ставки/день» **в этой таблице больше нет** — она живёт только внутри
Табель-попапа (см. ниже). Bulk save ManagersTab специально не отправляет
поле `dailyRate`, чтобы не затереть значение, заданное в Табеле.

---

## Database — single source of truth (D1, `D1_roleplay` Neon DB)

Все четыре таблицы лежат в одной БД (`DATABASE_URL`, project `cold-recipe-13625086`,
database `D1_roleplay`). OKK / R-копии ничего не знают про расписание и табель.

### `master_managers` — каждый менеджер компании, оба отдела

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | sync target в OKK / Ролевках |
| `name` | text | каноничное имя |
| `telegram_username`, `telegram_id` | text | MTProto resolution |
| `department` | text | `'b2g'` / `'b2b'` |
| `team` | text | `'dima'` (B2G) / `'ruzanna'` (B2B) |
| `role` | text | `'manager'` / `'rop'` / `'admin'` |
| `line` | text \| null | `'1'` / `'2'` / `'3'` (B2G), null (B2B) |
| `kommo_user_id` | int | matched by name auto |
| `callgear_employee_id`, `cloudtalk_agent_id` | text | telephony |
| `in_okk`, `in_rolevki` | bool | sync flags |
| `is_active` | bool | soft delete |
| `shift_start_time`, `shift_end_time` | text "HH:MM" | дефолт смены |
| **`daily_rate`** | numeric(12,2) | дневная ставка для Табеля |

«ROP+линия» — даблстатус: `role='rop' AND line IS NOT NULL` означает, что
человек одновременно руководит и работает на линии. Таблица расписания, фильтры
по линиям и таблицы Звонков уважают это (см. `project_double_status` memory).

#### Sync targets (записываются автоматом при POST /api/managers)

`master_managers` — single source of truth, но при upsert он расходится по 4 копиям:

| DB connection | Таблица | Когда пишется | Ключевые колонки |
|---|---|---|---|
| **D2** (`D2_OKK_DATABASE_URL`) | `managers` | `inOkk=true` AND `department='b2g'` | `id` (соответствует master_managers.id), `name`, `kommo_user_id`, `line`, `role`, `is_active`, `callgear_employee_id`, `cloudtalk_agent_id` |
| **R2** (`R2_OKK_DATABASE_URL`) | `managers` | `inOkk=true` AND `department='b2b'` | то же |
| **D1** (`DATABASE_URL`) | `d1_users` | `inRolevki=true` AND `department='b2g'` AND `telegramId IS NOT NULL` | `id`, `telegram_id`, `name`, `team`, `role`, `line`, `kommo_user_id`, `is_active` |
| **R1** (`R1_DATABASE_URL`, авто-derive из D1 если не задан) | `r1_users` | `inRolevki=true` AND `department='b2b'` AND `telegramId IS NOT NULL` | то же |

Soft-delete: при удалении менеджера в master_managers ставится `is_active=false` (FK в калах сохраняется), и в sync-targets также `is_active=false`. Кали из истории остаются.

### `manager_schedule` — что менеджер делает в конкретный день

| Column | Type | Notes |
|---|---|---|
| `id` | serial PK | |
| `user_id` | UUID → `master_managers.id` | |
| `schedule_date` | text `YYYY-MM-DD` | civil date в Europe/Berlin |
| `is_on_line` | bool | derived из schedule_value, нужен Звонкам |
| `schedule_value` | text | one of canonical codes (см. ниже) |
| `shift_start_time`, `shift_end_time` | text \| null | per-day override |

Один день = одна строка. Bulk-save в Календаре PUT'ит сразу N строк (по числу
заполненных ячеек). Пустые дни в БД отсутствуют (грид UI показывает их пустыми).

### `manager_bonuses` — ручная ежемесячная премия

| Column | Type | Notes |
|---|---|---|
| `id` | serial PK | |
| `user_id` | UUID → `master_managers.id` | |
| `period_month` | text `YYYY-MM` | UNIQUE (user_id, period_month) |
| `amount` | numeric(12,2) NOT NULL | положительная сумма |
| `note` | text \| null | "за что" |
| `created_at`, `updated_at` | timestamptz | |

«Очистить премию» = `DELETE FROM manager_bonuses WHERE …` (нет нулевых строк).
Премия **плюсуется** к гроссу: `gross = equiv_days × daily_rate + bonus`.

### `payroll_runs` — snapshot табеля на закрытый месяц

| Column | Type | Notes |
|---|---|---|
| `id` | serial PK | |
| `department` | text | upsert key #1 |
| `period_month` | text `YYYY-MM` | upsert key #2 |
| `user_id` | UUID → `master_managers.id` | upsert key #3 |
| `manager_name` | text | snapshot |
| `daily_rate` | numeric(12,2) \| null | snapshot |
| `status_breakdown` | jsonb | `{ "8": 18, "о": 5, ... }` |
| `equiv_full_days` | numeric(8,2) | Σ payrollFactor |
| `bonus_amount` | numeric(12,2) NOT NULL DEFAULT 0 | snapshot of premium |
| `gross_amount` | numeric(14,2) | equiv × rate + bonus |
| `computed_at` | timestamptz | |

Snapshot пишется **месячным кроном** или вручную (POST на payroll-эндпоинт).
Re-run upsert'ит существующую строку — повторный прогон не плодит дубли. Поля
снимка заморожены, чтобы будущая правка ставки или премии не переписала
исторический табель.

---

## ER

```
master_managers (id PK)
   ├── 1:N  manager_schedule (user_id FK)        ← дневной грид (Календарь)
   ├── 1:N  manager_bonuses  (user_id FK)        ← ежемесячная премия (Табель)
   └── 1:N  payroll_runs     (user_id FK)        ← закрытый месяц snapshot
                            (department, period_month, user_id) UNIQUE

schedule_value ∈ {8, 4, -, о, н, у}
       └─→ src/lib/daily/schedule-payroll.ts (canonical SCHEDULE_STATUSES)
              ├ payrollFactor   ←─ умножается на dailyRate
              ├ countsAsOnLine  ←─ драйвит SLA-окно + Звонки
              └ paidLeave       ←─ помечает «оплачивается без работы»
```

---

## Канонические статусы расписания

Источник истины — `src/lib/daily/schedule-payroll.ts`. **Никогда не инлайньте
эти числа в другие файлы** — импортируйте `SCHEDULE_STATUSES` /
`payrollFactorFor()` / `isOnLineFor()`.

| Code | Label | Symbol | payrollFactor | onLine | paidLeave |
|---|---|---|---|---|---|
| `8` | Полный день | ☀ | 1.0 | true | false |
| `4` | Половина дня | ◑ | 0.5 | true | false |
| `-` | Выходной | — | 0.0 | **false** | false |
| `о` | Отпуск | 🌴 | 1.0 | **false** | true |
| `н` | Онбординг | 🚀 | 1.0 | true | true |
| `у` | День увольнения | 🔴 | 1.0 | true | false |

Чтобы добавить новый статус — добавьте строку в `SCHEDULE_STATUSES`. Picker в
Календаре, легенда, формула табеля и `is_on_line` в API подтянутся
автоматически.

---

## API surface

| Endpoint | Verb | Auth | Что делает |
|---|---|---|---|
| `/api/managers` | GET | session | список master_managers по отделу |
| `/api/managers` | POST | **admin** | bulk upsert (НЕ трогает daily_rate) |
| `/api/daily/managers` | GET | session | то же + RopWithLine, для Календаря |
| `/api/daily/managers` | PATCH | **admin** | single field: shiftStart/End / dailyRate |
| `/api/daily/schedule` | GET | session | `?date=YYYY-MM-DD` или `?month=YYYY-MM` |
| `/api/daily/schedule` | PUT | **admin** | bulk save N entries за месяц (атомарно) |
| `/api/daily/payroll` | GET | **admin** | preview + опционально `&persist=1` |
| `/api/daily/payroll` | POST | **admin** | compute + persist в payroll_runs |
| `/api/daily/payroll/year` | GET | **admin** | manager × month grid (12 месяцев) |
| `/api/daily/payroll/bonus` | PATCH | **admin** | upsert/delete премии за месяц |
| `/api/daily/payroll/cron` | GET | `CRON_SECRET` (header) | snapshot обоих отделов |

Все мутации записывают через **`INSERT … ON CONFLICT DO UPDATE`** (Drizzle
`onConflictDoUpdate`) на уникальном индексе целевой таблицы — TOCTOU-гонка
исключена. Bulk-PUT расписания — один multi-row statement, поэтому либо
весь батч пишется, либо ничего (Neon HTTP-драйвер не поддерживает
транзакции, поэтому именно один statement).

---

## Дата-флоу

### Календарь (расписание)

1. Открытие попапа → GET `/api/daily/schedule?month=YYYY-MM` → строится
   grid `userId × dayIdx`
2. Клик на ячейку → portal-picker предлагает 6 кодов → in-memory state
3. Save → PUT `/api/daily/schedule` со списком всех непустых ячеек →
   `setSchedule(userId, date, isOnLine, value, shiftStart, shiftEnd)` для
   каждой → upsert в `manager_schedule`. `is_on_line` derive'ится из
   value через `scheduleValueToIsOnLine` (только `-`/`о` = false).
4. Поля shift_start/end в строках расписания **не** перезаписываются bulk
   save'ом (см. комментарий в SchedulePopup `handleSave` — иначе текущее
   значение в master_managers затрёт исторические per-day override'ы).

### Табель (расчёт оплаты)

1. Открытие попапа → GET `/api/daily/payroll/year?year=YYYY&department=…`
2. Endpoint вызывает `computePayroll(department, month)` для всех 12
   месяцев и pivot'ит результат в `manager × month` сетку.
3. `computePayroll`:
   - тянет всех активных менеджеров отдела с их `daily_rate`;
   - грузит все строки `manager_schedule` за месяц;
   - грузит все строки `manager_bonuses` за месяц;
   - считает `breakdown[code] = count`, потом
     `equiv = Σ count × payrollFactor[code]`,
     `base = equiv × rate`, `gross = base + bonus`.
4. Inline-edit ставки → PATCH `/api/daily/managers` `{id, dailyRate}` →
   refetch year.
5. Клик по ячейке месяца → popover с amount/note → PATCH
   `/api/daily/payroll/bonus` `{userId, periodMonth, amount, note}`. При
   `amount=null|""|0` строка `manager_bonuses` удаляется. Refetch year.

### Cron (закрытие месяца)

`GET /api/daily/payroll/cron?secret=<CRON_SECRET>[&month=YYYY-MM]`

- Без `?month` → берёт **закрывшийся** месяц по Europe/Berlin
  (`previousMonthBerlin()`). Можно безопасно вызывать как 23:50 последнего
  дня, так и 02:00 первого числа — оба попадут на нужный период.
- Считает `computePayroll` для b2g и b2b, upsert в `payroll_runs` по
  ключу `(department, period_month, user_id)`. Snapshot сохраняет ставку,
  bonus_amount, breakdown — чтобы будущие правки не двигали историю.

Рекомендуемое расписание Dokploy: `0 2 1 * *` Europe/Berlin.

---

## Auth model

- **GET / list**: любая авторизованная сессия.
- **Все мутации schedule + payroll + manager-fields**: `role='admin'`.
  Включает bulk POST `/api/managers`, PATCH `/api/daily/managers` (ставка
  и shift-time), PUT `/api/daily/schedule`, все payroll-эндпоинты.
- **Cron**: только заголовок `x-cron-secret: <CRON_SECRET>`. Query-string
  `?secret=` намеренно НЕ принимается — это утечка через access-логи и
  referer. Cессия не нужна.

UI Табеля admin-only **on the server** — фронт не прячет кнопку «Табель»
для не-админов; при загрузке `TabelPopup` обработает 403 и покажет
«Доступ только для администратора» вместо «нет менеджеров». Если нужно
ещё и кнопку прятать — добавить gate в `ManagersTab` по `session.role`.

---

## Известные ограничения / gotchas

- Drizzle `numeric` возвращает **строку**, не number. `computePayroll`
  парсит через `parseFloat`. При добавлении новых numeric-колонок не
  забудьте `Number.parseFloat(value)`.
- Изменение схемы (`schema-existing.ts`) **должно сопровождаться**
  применением SQL в Neon ДО пуша кода — drizzle `.select()` без
  projection эмитит явный список колонок и упадёт на отсутствующих
  (`feedback_drizzle_migration_first` memory). Полный текст миграции —
  в `scripts/payroll-migration.sql`, идемпотентный.
- Даты везде в **Europe/Berlin civil components** — не UTC. Это касается
  `previousMonthBerlin()`, `monthBounds()`, и любых будущих сравнений.
- ROP с пустой `line` пропадает из расписания (не считается «работающим
  на линии»). Если нужен в Календаре — задайте ему `line` в Менеджерах.
- Year-endpoint делает **12 последовательных** `computePayroll` — для 17+9
  активных менеджеров это терпимо. При росте >50 менеджеров стоит
  паралеллизовать `Promise.all(months.map(computePayroll))`.

---

## История ревью

**2026-04-30** — code-reviewer agent, итоговый verdict «Block — see Blockers».
После ревью применены все Blockers + Highs + 2 из 3 Mediums:

- ✅ **BLOCKER** Auth-гейт на `PATCH /api/daily/managers` (был открыт).
- ✅ **BLOCKER** Auth-гейт на `PUT /api/daily/schedule` (был открыт).
- ✅ **HIGH** Все upsert'ы переписаны на `onConflictDoUpdate`
  (`payroll_runs`, `manager_bonuses`, `manager_schedule`) — TOCTOU гонка
  устранена. Дубль-функция `persistRun` извлечена в
  `src/lib/daily/payroll-persist.ts` — общий код в одном месте.
- ✅ **HIGH** `computePayroll` фильтрует `manager_schedule` и
  `manager_bonuses` по списку UUID отдела (защита от cross-department
  collision при будущем переводе менеджера).
- ✅ **HIGH** Bulk `/api/daily/schedule` PUT теперь — один multi-row
  INSERT со встроенным upsert; partial-write невозможен (либо все N
  строк, либо никаких). Neon HTTP-драйвер не даёт транзакций, поэтому
  именно один statement.
- ✅ **MED** `previousMonthBerlin` на `formatToParts` (regex-парс
  ICU-формата убран — был хрупок к смене locale).
- ✅ **MED** `TabelPopup` различает 403 и «нет менеджеров».
- ✅ **MED** `CRON_SECRET` снят с query-string (только header) — больше
  не утечёт через логи.
- 🟡 **LOW** «Несохранённые правки месяца теряются при стрелке Next/Prev»
  в SchedulePopup — не закрыто, оставлено follow-up'ом.

## Файловая карта

| Что | Где |
|---|---|
| UI | `src/components/ManagersTab.tsx`, `SchedulePopup.tsx`, `TabelPopup.tsx` |
| Канонические статусы | `src/lib/daily/schedule-payroll.ts` |
| Калькулятор | `src/lib/daily/payroll.ts` |
| Schema | `src/lib/db/schema-existing.ts` (masterManagers, managerSchedule, payrollRuns, managerBonuses) |
| API | `src/app/api/managers/`, `src/app/api/daily/managers/`, `src/app/api/daily/schedule/`, `src/app/api/daily/payroll/` |
| Migration | `scripts/payroll-migration.sql` |
