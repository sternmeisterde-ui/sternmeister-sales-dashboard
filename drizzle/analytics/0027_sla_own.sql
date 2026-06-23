-- 0027_sla_own.sql
--
-- «Свой» SLA для Бух Комм (B2B) — независимый от интегратора/Looker.
-- Спека (Рузанна): рабочие часы (Пн–Сб 09:00–18:00 Берлин) от входа лида
-- в статус «Новый лид» в воронке «Бух Комм» до первого звонка по лиду.
-- Корнер-кейсы и исключения см. в src/lib/etl/compute-sla.ts.
--
--   sla_own_seconds — значение в секундах рабочего времени (NULL = не считаем).
--   sla_own_status  — отладочная метка ветки расчёта.
--
-- Apply via Neon SQL editor (Analytics DB).

ALTER TABLE analytics.sla
  ADD COLUMN IF NOT EXISTS sla_own_seconds BIGINT,
  ADD COLUMN IF NOT EXISTS sla_own_status  TEXT;
