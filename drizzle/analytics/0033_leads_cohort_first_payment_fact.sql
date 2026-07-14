-- 0033_leads_cohort_first_payment_fact.sql
--
-- Строгий факт первого платежа: Kommo CFV 888296 «Факт. Дата 1-го платежа»,
-- читается по точному field_id. Существующий first_payment_date — НЕ факт:
-- findByName с алиасами подхватывает плановую «Дата 1-го платежа» (двух разных
-- полей: 876372 и 878914), когда факт пуст — июнь 2026 даёт 40 vs реальных 27.
-- Колонка нужна вкладке «Динамика категорий» (продажа = факт-дата заполнена,
-- когортно к дате создания лида). first_payment_date не трогаем — на нём
-- сидят факты Дейли (см. memory: daily-payment-fact-check).
--
-- Apply via Neon SQL editor (Analytics DB).

ALTER TABLE analytics.leads_cohort
  ADD COLUMN IF NOT EXISTS first_payment_fact_date timestamp;

COMMENT ON COLUMN analytics.leads_cohort.first_payment_fact_date IS
  'Строгий факт 1-го платежа (Kommo CFV 888296 «Факт. Дата 1-го платежа», по field_id). NULL = платежа не было. Отличать от first_payment_date (смесь план/факт по имени поля).';
