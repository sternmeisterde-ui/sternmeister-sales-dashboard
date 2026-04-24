# Daily — Коммерция (B2B) — Спецификация

Источник: `дейли коммерция.xlsx`, лист **ТЗ по Daily дашборду** + листы `Daily_Numbers`, `Weekly_Numbers`, `Monthly Numbers`, `Глоссарий`.

Задача — полностью реализовать Daily-вкладку для отдела **Коммерция (B2B)** так, чтобы:
- В `Daily` отображались все дни выбранного месяца с планом/фактом по всем метрикам ТЗ.
- В `Weekly` складывались значения Daily за неделю (Пн–Пт) по правилам столбца C в ТЗ.
- В `Monthly` был ввод ручных планов + агрегация факта из Daily.
- Работал «светофор»: фон ФАКТА красный <50%, жёлтый ≥50%, зелёный ≥100%.

Департаменты:
- **B2B (коммерция)** — воронки Бух Комм (`10631243`) и Medical Admin Comm (`13209983`). Команда `ruzanna`. OKK DB = R2, Roleplay DB = R1.
- B2G (госники) — отдельный спек, не трогаем.

---

## 1. Разделы и показатели (строго по ТЗ)

Порядок разделов сверху вниз в Daily:

1. **Total UE** — информационная шапка (LTV, CAC, LTV/CAC, лиды тотал, выручка, конверсия).
2. **Marketing** — CAC/CPL/лиды/бюджет (основной канал).
3. **Influence Marketing** — отдельный источник трафика.
4. **FB Marketing** — отдельный источник трафика.
5. **Продажи ТОТАЛ** — сводные метрики по Бух + Мед.
6. **Продажи Бух** — воронка Бух Комм (`10631243`), per-manager.
7. **Продажи Мед** — воронка Medical Admin Comm (`13209983`), per-manager.
8. **Звонки** — per-manager, из Callgear + Cloudtalk (analytics DB).
9. **ОКК** — средние оценки по ОКК (R2) с разбивкой Бух 1 / Бух 2 / Мед.
10. **Продления** — по потокам с конкретными датами (29.04, 27.05, …).

---

## 2. Сводные (ТОТАЛ) формулы

| Показатель | Daily / Weekly | Monthly |
|---|---|---|
| Выручка Total план | `Новая выручка план` + `Продления Бух план` | + ручной ввод «выручка план шайны» |
| Выручка Total факт | `Новая выручка факт` + `Продления Бух факт` | + ручной ввод «выручка факт шайны» |
| Новая выручка план | `Новая выручка Бух план` + `Новая выручка Мед план` | = Daily/Weekly |
| Новая выручка факт | `Новая выручка Бух факт` + `Новая выручка Мед факт` | = Daily/Weekly |
| Всего ком. лидов план | `Квал ком. Бух лидов план` + `Квал ком. Мед лидов план` | = Daily/Weekly |
| Всего ком. лидов факт | `Квал ком. Бух лидов факт` + `Квал ком. Мед лидов факт` | = Daily/Weekly |
| Количество продаж план | `Количество продаж Бух план` + `Количество продаж Мед план` | = Daily/Weekly |
| Количество продаж факт | `Количество продаж Бух факт` + `Количество продаж Мед факт` | = Daily/Weekly |
| Количество предоплат | `Количество предоплат Бух` + `Количество предоплат Мед` | = Daily/Weekly |
| QL2P план % | `8%` по умолчанию (меняется только в Monthly) | ручной |
| QL2P факт % | AVG(`QL2P Бух факт %`, `QL2P Мед факт %`) | = Daily/Weekly |
| Средний чек план | AVG(`Средний чек Бух план`, `Средний чек Мед план`) | = Daily/Weekly |
| Средний чек факт | AVG(`Средний чек Бух факт`, `Средний чек Мед факт`) | = Daily/Weekly |
| Выполнено плана TOTAL | `Выручка Total факт` / `Выручка Total план` | = Daily/Weekly |
| Выполнено плана NEW | `Новая выручка факт` / `Новая выручка план` | = Daily/Weekly |

---

## 3. Продажи Бух (воронка Бух Комм — pipeline_id `10631243`)

| Ключ | Показатель | План/факт | Источник факта |
|---|---|---|---|
| `buh_salesPlusRenewals_p` | Продажи + Продления Total Бух план | план-строка | `buh_revenue_p` + `Продления Бух план` |
| `buh_salesPlusRenewals_f` | Продажи + Продления Total Бух факт | факт-строка | `buh_revenue_f` + `Продления Бух факт` |
| `buh_revenue_p` | Новая выручка Бух план | план-строка | `buh_sales_p * buh_avgCheck_p` |
| `buh_revenue_f` | **Новая выручка Бух факт** | факт-строка | СУММА кастомного поля `Сумма 1-го платежа` по лидам, где `Факт. Дата 1-го платежа` ∈ period **+** СУММА `Сумма предоплаты` по лидам, где `Дата предоплаты` ∈ period |
| `buh_komLeads_p` | Квал ком. Бух лидов план | план-строка | Из Monthly / дни месяца |
| `buh_komLeads_f` | **Квал ком. Бух лидов факт** | факт-строка | Все лиды pipeline_id=10631243 по `created_at` ∈ period, за исключением: `Incoming` (81523499), а также lost-леды с loss_reason содержащим `Неквал` или `Спам` |
| `buh_totalLeads_p` | Всего лидов план | план-строка | Из Monthly / дни месяца |
| `buh_totalLeads_f` | Всего лидов факт | факт-строка | Все лиды pipeline_id=10631243 по `created_at` ∈ period (без исключений) |
| `buh_sales_p` | Количество продаж Бух план | план-строка | `buh_komLeads_p * buh_ql2p_p / 100` |
| `buh_sales_f` | **Количество продаж Бух факт** | факт-строка | Кол-во лидов pipeline_id=10631243, где `Факт. Дата 1-го платежа` ∈ period |
| `buh_prepayments` | **Количество предоплат Бух** | факт-строка | Кол-во лидов pipeline_id=10631243, где `Дата предоплаты` ∈ period |
| `buh_ql2p_p` | QL2P Бух план % | план-строка | 8% по умолчанию |
| `buh_ql2p_f` | QL2P Бух факт % | факт-строка | `buh_sales_f / buh_komLeads_f` |
| `buh_l2p_p` | L2P Total Бух план % | план-строка | 5% по умолчанию |
| `buh_l2p_f` | L2P Total Бух факт % | факт-строка | `buh_sales_f / buh_totalLeads_f` |
| `buh_avgCheck_p` | Средний чек Бух план | план-строка | Из Monthly (ручной ввод) |
| `buh_avgCheck_f` | Средний чек Бух факт | факт-строка | `buh_revenue_f / buh_sales_f` |
| `buh_planDoneTotal` | Выполнено плана TOTAL БУХ | факт-строка | `buh_salesPlusRenewals_f / buh_salesPlusRenewals_p` |
| `buh_planDoneNew` | Выполнено плана NEW БУХ | факт-строка | `buh_revenue_f / buh_revenue_p` |

---

## 4. Продажи Мед (воронка Medical Admin Comm — pipeline_id `13209983`)

Структурно идентично Бух, но:
- `med_komLeads_f` — нет фильтра по Incoming (воронка Мед не имеет Incoming-статуса). Сохраняем только lost-reason `Неквал`/`Спам`.
- Kommo custom fields с тем же именем (`Факт. Дата 1-го платежа`, `Сумма 1-го платежа`, `Дата предоплаты`, `Сумма предоплаты`) ожидаются в Medical-воронке. Если каких-то полей нет, используется фолбек: lead.price на won-леде + статус PREPAYMENT.

Ключи: `med_salesPlusRenewals_p/_f`, `med_revenue_p/_f`, `med_komLeads_p/_f`, `med_totalLeads_p/_f` (добавляем), `med_sales_p/_f`, `med_prepayments`, `med_ql2p_p/_f`, `med_l2p_p/_f` (добавляем), `med_avgCheck_p/_f`, `med_planDoneTotal`, `med_planDoneNew`.

---

## 5. Звонки (per-manager)

| Ключ | Формула |
|---|---|
| `calls_managersOnLine_p` | Ручной план из Monthly |
| `calls_managersOnLine_f` | Daily: кол-во менеджеров `on_line=true` в графике на этот день. Weekly/Monthly: кол-во активных менеджеров в отделе. |
| `calls_total_p` | `calls_managersOnLine_f * 80` |
| `calls_total_f` | `SUM(callsTotal)` из analytics DB (Callgear + Cloudtalk), pipeline_id ∈ {10631243, 13209983}, manager ∈ sectionManagers |
| `calls_totalMinutes_p` | `calls_managersOnLine_f * 160` |
| `calls_totalMinutes_f` | `SUM(totalMinutes)` из analytics DB |
| `calls_avgWait_p` | `35` по умолчанию |
| `calls_avgWait_f` | AVG waiting_time (analytics) |
| `calls_dialPercent_p` | `65%` по умолчанию |
| `calls_dialPercent_f` | `callsConnected / callsTotal * 100` |
| `calls_sla_p` | `25` по умолчанию |
| `calls_sla_f` | AVG `sla_first_call_seconds` из соответствующей Roleplay DB (R1) для B2B |

---

## 6. ОКК

| Ключ | Формула |
|---|---|
| `okk_buh1_p` | 85% по умолчанию |
| `okk_buh1_f` | AVG `totalScore` по `okkEvaluations` для первой линии Бух из R2 |
| `okk_buh2_p` | 85% по умолчанию |
| `okk_buh2_f` | AVG `totalScore` для второй линии Бух из R2 |
| `okk_med_p` | 85% по умолчанию |
| `okk_med_f` | AVG `totalScore` для мед-менеджеров из R2 (если различимы по тэгу) |
| `okk_avg_p` | AVG(okk_buh1_p, okk_buh2_p, okk_med_p) |
| `okk_avg_f` | AVG(okk_buh1_f, okk_buh2_f, okk_med_f) |

В B2B нет явного различения линий. Если таблица `managers.line` не заполнена — берём все оценки в окк_buh1 и оставляем 2/мед = null.

---

## 7. Продления (Renewals)

- Daily: ручной ввод плана по каждой дате (`29.04`, `27.05`, `27.06`, `28.07`, `29.08`, `29.09`, `17.10`, `10.11`, `28.11`, `8.12`, `19.01`, `9.02`, `9.03.26`, `7.04.26`) + факт (из Kommo, если привязан к контрактной воронке) + к оплате = план − факт.
- Weekly/Monthly — суммирование Daily.
- В коде: ключи `ren_<DATE>_plan`, `ren_<DATE>_fact`, `ren_<DATE>_toPay`. Ключи агрегата — `ren_totalRevenue_p`, `ren_totalRevenue_f`, `ren_totalToPay`. Для Daily пока оставляем manual, API-интеграцию по продлениям — отдельным шагом (TBD, нет воронки в конфиге).

---

## 8. Kommo custom-field lookup

Все денежно-датные поля достаются по **имени** (`field_name`) из `lead.custom_fields_values`, т.к. `field_id` в разных аккаунтах может отличаться. Хелперы:

```ts
const FIELD_NAMES = {
  firstPaymentDate: ["Факт. Дата 1-го платежа", "Фактическая дата 1-го платежа"],
  firstPaymentAmount: ["Сумма 1-го платежа"],
  prepaymentDate: ["Дата предоплаты"],
  prepaymentAmount: ["Сумма предоплаты"],
};
```

Значения дат в Kommo — Unix timestamp (секунды) или строка — хелпер должен нормализовать.

---

## 9. Исключения для квал-лидов

Квал лид = создан в period, **не** (pipeline=Бух Комм И status=Incoming) **и не** (closed_at != null И loss_reason содержит `Неквал` или `Спам`, case-insensitive).

Loss reasons в Kommo это enum (`GET /api/v4/leads/loss_reasons`). Кэшируем их при первом вызове, строим Set id → name, фильтруем.

---

## 10. Светофор

Клиент рендерит бэкграунд клетки «Факт» в зависимости от `percent = fact/plan`:
- `<50%` — `bg-red-200/20`
- `50..99%` — `bg-yellow-200/20`
- `>=100%` — `bg-green-200/20`

Для метрик без плана бэкграунд не применяется.

---

## 11. Пути в коде

- `src/lib/daily/metrics-config-b2b.ts` — секции B2B (перестраиваем полностью).
- `src/lib/daily/build-response.ts` — хелперы `getB2BCommercialFacts`, `getB2BQualifiedLeads`, `getCustomFieldSum`, `getCustomFieldCount` + ветка B2B в основной сборке.
- `src/lib/kommo/pipeline-config.ts` — дополняется константами FIELD_NAMES, LOSS_REASON_PATTERNS (`/Неквал|Спам/i`), экспорт `B2B_QUAL_LEAD_EXCLUDED_STATUSES` = {COMMERCIAL_STATUSES.INCOMING}.
- `src/components/DailyTab.tsx` — проверить, что B2B секции рендерятся (ранее были `salesBuh`/`salesMed` с perManager). Исправить, если что-то отвалилось.

---

## 12. Таск-лист (см. `TaskList`)

1. Документация (этот файл) — **в работе**.
2. Аудит B2B конфига + build-response.
3. Перестройка `metrics-config-b2b.ts`.
4. Расширение `pipeline-config.ts`.
5. Реализация фактов в `build-response.ts`.
6. Звонки/ОКК/Продления.
7. Клиент DailyTab.
8. Мультиагентный аудит.
