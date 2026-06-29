-- 0030_drop_cloudtalk_call_events.sql
--
-- Откат вебхук-атрибуции дайлера. Таблицу `cloudtalk_call_events` (0029)
-- заводили под идею «дайлер vs ручной» по `campaign_id` из вебхука CloudTalk
-- (Workflow «Call Ended» → API Request). На реальных звонках подтвердилось, что
-- триггер «Call Ended» НЕ несёт привязку к кампании: `campaign_id`/`disposition`
-- приходят null даже у дозвонившихся дайлер-звонков (привязка к кампании в
-- CloudTalk живёт только в статистике/CSV самой кампании, не на объекте звонка).
-- Подход закрыт; изоляция дайлера осталась на сужении по воронке Бух Гос (10935879).
--
-- Перед применением: удалить/выключить CloudTalk Workflow и убрать
-- CLOUDTALK_WEBHOOK_SECRET из Dokploy, иначе вебхук будет стучаться в
-- удалённый endpoint (безвредно, но шумно).
--
-- Apply via Neon SQL editor (Analytics DB).

DROP TABLE IF EXISTS analytics.cloudtalk_call_events;
