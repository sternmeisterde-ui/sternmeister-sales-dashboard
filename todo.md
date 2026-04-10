# Sternmeister Dashboard — TODO

## DONE (сессия 2026-04-09/10)

### Daily Tab
- [x] Таблица `daily_snapshots` для исторических данных
- [x] Таймзона Europe/Berlin вместо UTC
- [x] Реконструкция `activeDeals` для прошлых дат
- [x] Kommo token refresh каждые 30 мин + 401 auto-reset
- [x] `/api/daily/health` диагностика
- [x] Concurrency limit в range API (3)
- [x] Department-aware pipeline IDs (getPipelineIds/getActiveStatusIds)
- [x] aggregateLeadFunnelMetrics + department param, B2B_QUALIFIED_STATUSES
- [x] Month boundary fix (dateStr вместо UTC timestamp)
- [x] FUNNEL_STATUS_MAP skip для B2B

### Kommo Client
- [x] Rate limit: 100ms → 145ms (7 req/s limit)
- [x] 429 retry с retry_after
- [x] Notes endpoint: /contacts/notes → /leads/notes (КРИТИЧНО — звонки были 0)
- [x] Event filter: filter[type] → filter[type][] (array)
- [x] Status change: log errors вместо silent break
- [x] Config promise reset on rejection

### Менеджеры
- [x] Orphan cleanup при каждом сохранении мастер-таблицы
- [x] Очистка d1_users, r1_users, OKK D2/R2 от уволенных
- [x] ROPs убраны из плашек/статистики ролевок и OKK

### UI
- [x] KPI карточки сужены (2-col grid)
- [x] Менеджеры в столбик со скроллом
- [x] Плашка "Динамика" с графиками (средний балл + кол-во по дням)
- [x] CallsChart компонент (Recharts)

### БД
- [x] D1 branch restored (380 звонков восстановлены через Neon point-in-time)
- [x] call_type колонка восстановлена в d1_calls + добавлена в schema
- [x] r1_users заполнены на D1 и R1 ветках
- [x] OKK D2 почищен (уволенные деактивированы)
- [x] daily_snapshots, r1_users, r1_calls, r1_avatars таблицы созданы через ALTER

---

## TODO: B2B Daily Tab (коммерция) — СЛЕДУЮЩАЯ СЕССИЯ

### Источник правды
- Файл: `/Users/user/Dashbord/Числа Daily Weekly Monthly.xlsx`
- Вкладка `Daily_Numbers` — 167 метрик, дни = столбцы (Target/Fact)
- Вкладка `Weekly_Numbers` — 112 метрик, недели
- Вкладка `Monthly Numbers` — 984 строк, месяцы
- Последние заполненные данные: июль 2025 (col 99)

### Секции из Excel → Daily tab B2B

#### 1. Total UE (Unit Economics)
- LTV, CAC, LTV/CAC — формулы из Excel
- Лиды тотал, Лиды категории А и Б — Kommo API
- Потраченный бюджет — ручной ввод или ?
- Выручка — Kommo (won leads * средний чек)
- Конверсия % — формула

#### 2. Marketing
- Маркетинг CAC, CPL — формулы (бюджет / лиды)
- Лиды # — Kommo API (по источнику?)
- Лиды категории A, B, C — Kommo custom field
- Неквал лиды # — Kommo (фильтр по полю квалификации)
- Бюджет — ручной ввод

#### 3. Influence Marketing
- Аналогичная структура Marketing, отдельный источник
- Бюджет, CPL, Лиды, CPQL, CR, CAC, AOV, Revenue, ROMI
- Источники: бюджет = ручной, лиды = Kommo (по utm/источнику?)

#### 4. FB Marketing
- Та же структура
- Бюджет = ручной, лиды = Kommo

#### 5. Продажи ТОТАЛ
- **Продажи Бух** (бухгалтерия):
  - Pipeline: Бух Комм (10631243)
  - Новая выручка план/факт
  - Всего ком. лидов план/факт — Kommo getLeads
  - Количество продаж план/факт — Kommo won leads
  - Количество предоплат — Kommo (статус "Предоплата получена" 82946499)
  - QL2P % — формула (продажи / квал лиды)
  - L2P % — формула (продажи / все лиды)
  - Средний чек план/факт — формула (выручка / продажи)
- **Продажи Мед** (медицина):
  - Pipeline: Medical Admin Commercial (13209983)
  - Аналогичная структура

#### 6. Звонки (аналог секции Госников)
- Менеджеров на линии — из schedule DB
- Количество звонков — Kommo Events API (getCallNotes)
- Всего на линии (минут) — aggregateCallMetrics
- Среднее время ожидания ответа — ?
- % дозвона — aggregateCallMetrics.dialPercent
- SLA (мин) — ? (нужно определить формулу)

#### 7. ОКК
- ОКК Бух 1/2 план/факт — из OKK DB (R2 evaluations)
- ОКК Мед план/факт — из OKK DB
- ОКК средний % — формула

#### 8. Продления
- Выручка по потокам (даты: 29.04, 27.05, 27.06...)
- План/Факт/К оплате
- Источник: Kommo или ручной ввод

### Маппинг Kommo Pipelines → B2B метрики

| Pipeline | ID | Для чего |
|----------|------|---------|
| Бух Комм | 10631243 | Продажи Бух: лиды, продажи, выручка |
| Medical Admin Commercial | 13209983 | Продажи Мед: лиды, продажи, выручка |

### Статусы B2B (Бух Комм pipeline 10631243)
- INCOMING: 81523499
- TECH: 83364011
- NEW_LEAD: 81523503
- IN_PROGRESS: 81523507
- NO_ANSWER: 82883595
- CONTACT_MADE: 81523515
- NO_CONSENT: 88519479
- INTEREST_CONFIRMED: 82661915
- INVOICE_SENT: 82661919
- PREPAYMENT: 82946495
- INSTALLMENT: 82946499
- WON: 142
- LOST: 143

### Что нужно определить (?)
- [ ] SLA формула — как рассчитывается?
- [ ] Бюджет Marketing / FB / Influence — откуда берутся? Ручной ввод?
- [ ] CPL / CPQL — формулы (бюджет / лиды, бюджет / квал лиды)?
- [ ] LTV — формула? Средний чек * кол-во продлений?
- [ ] CAC — формула? Бюджет маркетинга / кол-во продаж?
- [ ] Продления — данные из Kommo или отдельная система?
- [ ] Medical Admin Commercial pipeline — статусы (нужно загрузить из Kommo)
- [ ] Среднее время ожидания ответа — как считается?
- [ ] UTM/источник лидов для разделения Marketing/FB/Influence

### Технические задачи
- [ ] Создать B2B metrics-config (metrics-config-b2b.ts или расширить existing)
- [ ] Добавить Medical pipeline IDs в pipeline-config.ts
- [ ] Реализовать build-response для B2B секций
- [ ] Добавить ручной ввод метрик (бюджет, планы) через UI
- [ ] Формулы: LTV, CAC, CPL, CPQL, QL2P, L2P, ROMI, средний чек
- [ ] Тесты: проверить каждую метрику на реальных данных

---

## Прочие TODO

### Проверить
- [ ] R1 evaluation-service: редеплоить (Dockerfile fix — COPY prompts/)
- [ ] Discord уведомления от Sentry для всех 4 проектов
- [ ] R1 batched evaluation работает после деплоя
- [ ] Дейли B2G: проверить что /leads/notes фикс реально починил звонки

### Будущее
- [ ] Корреляция категория x блок оценки (heatmap)
- [ ] Тренд по менеджерам (кто растёт, кто падает)
- [ ] Экспорт данных в Excel
- [ ] Мобильная адаптивность
- [ ] НИКОГДА не использовать db:push на проде — только db:generate + db:migrate
