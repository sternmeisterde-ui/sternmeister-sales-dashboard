/**
 * Статистика drip-рассылки бота (репо berater_bot, ОТДЕЛЬНЫЙ Neon).
 *
 * Кампания «прогрев к термину» (termin_warmup_v2, B2G/Госники) шлёт авторизованным
 * клиентам цепочку сообщений от даты авторизации до термина. Здесь — те же цифры,
 * что у штатного отчёта бота `scripts/broadcast_report.py`, плюс разбивка по дням и
 * список получателей.
 *
 * ЧТЕНИЕ НАПРЯМУЮ из бот-Neon через getBeraterBotDb() (read-only, мы туда не пишем).
 * Имя сделки получателя дотягиваем из НАШЕЙ analytics (lead_contact_links→contacts),
 * т.к. база бота имён не хранит (только kommo_lead_id). Содержание сообщений — из
 * статической копии (src/lib/broadcast/campaign-content.*), мёрджит клиент.
 *
 * Бот-БД scale-to-zero «засыпает» → первый запрос может разбудить её за пару секунд
 * (UI показывает спиннер). Нет BERATER_BOT_DATABASE_URL / БД недоступна →
 * available:false (graceful). Telegram не отдаёт ботам «прочитано»/просмотры видео —
 * воронка обрывается на клике (см. berater_bot/deploy/BROADCAST_TRACKING.md).
 */
import { sql } from "drizzle-orm";
import { getBeraterBotDb } from "@/lib/db/berater-bot";
import { analyticsDb } from "@/lib/db/analytics";
import { getMessageContent, hasCampaignContent } from "./campaign-content";

/** Локальный распаковщик результата neon-http (массив либо {rows:[]}). */
function rows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && "rows" in result) {
    const r = (result as { rows: unknown }).rows;
    if (Array.isArray(r)) return r as T[];
  }
  return [];
}

/** Сколько строк-получателей максимум отдаём (защита от гигантских ответов). */
const RECIPIENTS_CAP = 2000;

export interface BroadcastStageRow {
  messageId: string; // msg_01 … msg_NN
  sent: number; // доставлено в периоде (broadcast_deliveries.status='sent')
  /** Уник. пользователей «пошёл в ролевку»: прямые клики по кнопке ∪
   *  ВОССТАНОВЛЕННЫЕ (правило юзера 2026-07-06: сессия бота, начатая в
   *  берлинский день доставки сообщения с кнопкой ролевки, приписывается
   *  рассылке). До деплоя фикса кликов в боте (63ad832) прямых кликов не
   *  было вовсе — инференс закрывает и историю, и будущее. */
  rpClick: number;
  /** Уник. пользователей, завершивших ролевку: прямые ∪ восстановленные
   *  (завершённая сессия в день доставки). */
  rpDone: number;
  link: number; // уник. пользователей, кликнувших по ссылке
}

export interface BroadcastDailyPoint {
  day: string; // YYYY-MM-DD (по sent_at)
  sent: number;
}

export interface BroadcastRecipient {
  sentAt: string; // ISO (UTC)
  messageId: string;
  telegramUsername: string | null;
  leadId: number | null; // kommo_lead_id
  leadName: string | null; // имя сделки из analytics (если нашли)
}

export interface BroadcastSubscriber {
  status: string; // active | completed | excluded
  suppressed: boolean; // «тихая отписка»
  telegramUsername: string | null;
  leadId: number | null;
  leadName: string | null;
  anchorAt: string | null; // дата авторизации (якорь дней 1–9)
  terminDate: string | null; // снимок даты термина
}

export interface BroadcastSubscriptionSummary {
  active: number;
  completed: number;
  excluded: number;
  suppressed: number; // «тихо отписались» (флаг suppressed=1)
  total: number;
}

export interface BroadcastDeliveryHealth {
  pending: number;
  sent: number;
  skipped: number; // не отправлены из-за жёсткого стопа / просрочки
  failed: number;
  total: number;
}

export interface BroadcastCampaignOption {
  campaignId: string;
  deliveries: number;
}

export interface BroadcastStats {
  available: boolean;
  campaignId: string | null;
  campaigns: BroadcastCampaignOption[];
  range: { from: string; to: string } | null;
  stages: BroadcastStageRow[];
  daily: BroadcastDailyPoint[];
  recipients: BroadcastRecipient[];
  recipientsTruncated: boolean;
  subscriptions: BroadcastSubscriptionSummary; // снимок по всей кампании (не period-scoped)
  subscribers: BroadcastSubscriber[]; // список подписчиков (для drill по карточкам)
  delivery: BroadcastDeliveryHealth; // снимок по всей кампании
}

const EMPTY_SUBS: BroadcastSubscriptionSummary = {
  active: 0,
  completed: 0,
  excluded: 0,
  suppressed: 0,
  total: 0,
};
const EMPTY_DELIVERY: BroadcastDeliveryHealth = {
  pending: 0,
  sent: 0,
  skipped: 0,
  failed: 0,
  total: 0,
};

function emptyStats(): BroadcastStats {
  return {
    available: false,
    campaignId: null,
    campaigns: [],
    range: null,
    stages: [],
    daily: [],
    recipients: [],
    recipientsTruncated: false,
    subscriptions: EMPTY_SUBS,
    subscribers: [],
    delivery: EMPTY_DELIVERY,
  };
}

type BotDb = NonNullable<ReturnType<typeof getBeraterBotDb>>;

/** Список кампаний, по которым есть доставки (по убыванию объёма). */
async function listCampaigns(bot: BotDb): Promise<BroadcastCampaignOption[]> {
  const data = rows<{ campaign_id: string; cnt: string | number }>(
    await bot.execute(sql`
      SELECT campaign_id, count(*) AS cnt
      FROM broadcast_deliveries
      GROUP BY campaign_id
      ORDER BY cnt DESC
    `),
  );
  return data
    .filter((r) => r.campaign_id)
    .map((r) => ({ campaignId: String(r.campaign_id), deliveries: Number(r.cnt) || 0 }));
}

/** Имя сделки по kommo_lead_id из НАШЕЙ analytics. Graceful: пусто при сбое. */
async function resolveLeadNames(leadIds: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  const ids = Array.from(
    new Set(leadIds.filter((n) => Number.isInteger(n) && n > 0)),
  );
  if (ids.length === 0) return out;
  try {
    // is_active=TRUE + ORDER BY first_seen_at — как в Воронке (src/lib/funnel/lead-list.ts):
    // у лида может быть несколько контактов, берём активный и детерминированно первый,
    // иначе имя «прыгает» между запросами и расходится с другими вкладками (#2 ревью).
    const data = rows<{ lead_id: string | number; name: string | null }>(
      await analyticsDb.execute(sql`
        SELECT l.lead_id, c.name
        FROM analytics.lead_contact_links l
        JOIN analytics.contacts c ON c.contact_id = l.contact_id
        WHERE l.lead_id IN (${sql.raw(ids.join(","))})
          AND l.is_active = TRUE
          AND c.name IS NOT NULL
        ORDER BY l.first_seen_at
      `),
    );
    for (const r of data) {
      const id = Number(r.lead_id);
      if (Number.isInteger(id) && r.name && !out.has(id)) out.set(id, String(r.name));
    }
  } catch (e) {
    console.error(
      "[broadcast] resolveLeadNames failed (non-fatal):",
      e instanceof Error ? e.message : e,
    );
  }
  return out;
}

export interface GetBroadcastStatsArgs {
  campaignId?: string;
  /** YYYY-MM-DD включительно. Фильтрует sent_at (этапы/дни/получатели) и created_at (клики). */
  from: string;
  to: string;
}

/**
 * Статистика рассылки за период [from, to]. campaignId не задан → самая «объёмная»
 * кампания. Любой сбой (нет env, спящая БД упала, иная схема) → available:false.
 *
 * Период применяется к sent_at (доставки) и created_at (взаимодействия) по БЕРЛИНСКОЙ
 * гражданской дате. Сводка подписок и здоровье доставки — снимок по всей кампании
 * (это lifecycle-состояния). Группировка по дню — берлинская дата sent_at.
 */
export async function getBroadcastStats(args: GetBroadcastStatsArgs): Promise<BroadcastStats> {
  const bot = getBeraterBotDb();
  if (!bot) return emptyStats();

  const { campaignId, from, to } = args;
  // Период и группировка — по БЕРЛИНСКОЙ гражданской дате (CLAUDE.md #1: TZ везде).
  // sent_at/created_at — text ISO с offset; приводим ::timestamptz и сдвигаем в Берлин,
  // затем сравниваем с [from, to+1day). Это убирает скос дня на границе суток (#3 ревью).
  const inBerlin = (col: string) =>
    sql`(${sql.raw(col)}::timestamptz AT TIME ZONE 'Europe/Berlin') >= ${from}::date
        AND (${sql.raw(col)}::timestamptz AT TIME ZONE 'Europe/Berlin') < (${to}::date + 1)`;

  try {
    const campaigns = await listCampaigns(bot);
    if (campaigns.length === 0) {
      return { ...emptyStats(), available: true, range: { from, to } };
    }
    const selected =
      (campaignId && campaigns.find((c) => c.campaignId === campaignId)?.campaignId) ||
      campaigns[0].campaignId;

    // --- ИСКЛЮЧЕНИЕ ТЕСТОВЫХ ПРОГОНОВ ---
    // Команды /campaign_test, /campaign_test_fast, /campaign_test_classic метят
    // подписку через termin_source ('test' | 'test_fast' | 'test_classic'); боевые —
    // 'dc'/'aa'. Тестеры (админы) — отдельные telegram_id, их данные не должны
    // попадать в аналитику. Собираем их user_id (для доставок) и telegram_id (для
    // реакций) и вычитаем из всех запросов.
    const testRows = rows<{ user_id: string | number; telegram_id: string | number | null }>(
      await bot.execute(sql`
        SELECT s.user_id, u.telegram_id
        FROM broadcast_subscriptions s
        LEFT JOIN users u ON u.id = s.user_id
        WHERE s.campaign_id = ${selected} AND s.termin_source LIKE 'test%'
      `),
    );
    const testUserIds = Array.from(
      new Set(testRows.map((r) => Number(r.user_id)).filter((n) => Number.isInteger(n))),
    );
    const testTgIds = Array.from(
      new Set(
        testRows.map((r) => Number(r.telegram_id)).filter((n) => Number.isInteger(n) && n > 0),
      ),
    );
    // Фрагменты «не тестовый». Идентификатор колонки — через sql.raw (контролируемая
    // строка), но значения параметризуем через sql.join (defense-in-depth, #10 ревью).
    const idList = (ids: number[]) => sql.join(ids.map((id) => sql`${id}`), sql`, `);
    const exclUser = (col: string) =>
      testUserIds.length ? sql` AND ${sql.raw(col)} NOT IN (${idList(testUserIds)})` : sql``;
    const exclTg = (col: string) =>
      testTgIds.length ? sql` AND ${sql.raw(col)} NOT IN (${idList(testTgIds)})` : sql``;

    // 6 запросов выше зависят только от testUserIds/testTgIds (уже посчитаны), друг от
    // друга — нет. Гоним их одним Promise.all: бот-Neon открывает соединение на запрос,
    // параллель безопасна и схлопывает ~6 round-trip'ов холодной БД в один (см. #5 ревью).
    const [sentRaw, interRaw, dailyRaw, recipientRaw, subRaw, subscriberRaw, healthRaw, inferredRaw] =
      await Promise.all([
        // 1. sent по сообщению (в периоде)
        bot.execute(sql`
          SELECT message_id, count(*) AS cnt
          FROM broadcast_deliveries
          WHERE campaign_id = ${selected} AND status = 'sent'
            AND ${inBerlin("sent_at")}${exclUser("user_id")}
          GROUP BY message_id
        `),
        // 2. реакции по (сообщение, действие, пользователь). telegram_id → user_id
        // через users (для объединения с восстановленными без задвоения);
        // без users-строки — синтетический uid по telegram_id.
        bot.execute(sql`
          SELECT DISTINCT bi.message_id, bi.action,
                 COALESCE(u.id::text, 'tg:' || bi.telegram_id::text) AS uid
          FROM broadcast_interactions bi
          LEFT JOIN users u ON u.telegram_id = bi.telegram_id
          WHERE bi.campaign_id = ${selected}
            AND ${inBerlin("bi.created_at")}${exclTg("bi.telegram_id")}
        `),
        // 3. отправки по дням (в периоде) — день = берлинская дата sent_at
        bot.execute(sql`
          SELECT to_char((sent_at::timestamptz AT TIME ZONE 'Europe/Berlin'), 'YYYY-MM-DD') AS day,
                 count(*) AS cnt
          FROM broadcast_deliveries
          WHERE campaign_id = ${selected} AND status = 'sent'
            AND ${inBerlin("sent_at")}${exclUser("user_id")}
          GROUP BY 1 ORDER BY 1
        `),
        // 4. получатели (кому отправили) — sent в периоде, с join users
        bot.execute(sql`
          SELECT d.sent_at, d.message_id, u.telegram_username, u.kommo_lead_id
          FROM broadcast_deliveries d
          LEFT JOIN users u ON u.id = d.user_id
          WHERE d.campaign_id = ${selected} AND d.status = 'sent'
            AND ${inBerlin("d.sent_at")}${exclUser("d.user_id")}
          ORDER BY d.sent_at DESC
          LIMIT ${RECIPIENTS_CAP + 1}
        `),
        // 5. сводка подписок (вся кампания)
        bot.execute(sql`
          SELECT status, suppressed, count(*) AS cnt
          FROM broadcast_subscriptions
          WHERE campaign_id = ${selected}
            AND COALESCE(termin_source, '') NOT LIKE 'test%'
          GROUP BY status, suppressed
        `),
        // 5b. подписчики (детально, для drill по карточкам) — без тестов. Кап на случай
        // разросшейся кампании; карточки-счётчики берутся из агрегата (5) и точны (#7 ревью).
        bot.execute(sql`
          SELECT s.status, s.suppressed, s.anchor_at, s.termin_date,
                 u.telegram_username, u.kommo_lead_id
          FROM broadcast_subscriptions s
          LEFT JOIN users u ON u.id = s.user_id
          WHERE s.campaign_id = ${selected}
            AND COALESCE(s.termin_source, '') NOT LIKE 'test%'
          ORDER BY s.anchor_at DESC
          LIMIT 2000
        `),
        // 6. здоровье доставки (вся кампания)
        bot.execute(sql`
          SELECT status, count(*) AS cnt
          FROM broadcast_deliveries
          WHERE campaign_id = ${selected}${exclUser("user_id")}
          GROUP BY status
        `),
        // 7. ВОССТАНОВЛЕННЫЕ клики/прохождения (правило юзера 2026-07-06):
        // сессия бота, начатая в тот же берлинский день, что и доставка
        // сообщения этому пользователю, приписывается рассылке (клики по
        // кнопке исторически не логировались — баг maxsplit, фикс 63ad832).
        // Одному дню — одна доставка (drip = 1 сообщение/день; при дублях
        // берём последнюю за день). finished = была ли в тот день ЗАВЕРШЁННАЯ
        // сессия (→ rpDone).
        bot.execute(sql`
          WITH sent AS (
            SELECT DISTINCT ON (d.user_id, (d.sent_at::timestamptz AT TIME ZONE 'Europe/Berlin')::date)
                   d.user_id,
                   d.message_id,
                   (d.sent_at::timestamptz AT TIME ZONE 'Europe/Berlin')::date AS day
            FROM broadcast_deliveries d
            WHERE d.campaign_id = ${selected} AND d.status = 'sent'
              AND ${inBerlin("d.sent_at")}${exclUser("d.user_id")}
            ORDER BY d.user_id, (d.sent_at::timestamptz AT TIME ZONE 'Europe/Berlin')::date, d.sent_at::timestamptz DESC
          ),
          sess AS (
            SELECT s.user_id,
                   (s.started_at::timestamptz AT TIME ZONE 'Europe/Berlin')::date AS day,
                   bool_or(s.finished_at IS NOT NULL) AS finished
            FROM sessions s
            GROUP BY 1, 2
          )
          SELECT sent.message_id, sent.user_id::text AS uid, sess.finished
          FROM sent
          JOIN sess ON sess.user_id = sent.user_id AND sess.day = sent.day
        `),
      ]);

    const sentRows = rows<{ message_id: string; cnt: string | number }>(sentRaw);
    const interRows = rows<{ message_id: string | null; action: string; uid: string }>(
      interRaw,
    );
    const inferredRows = rows<{ message_id: string | null; uid: string; finished: boolean | null }>(
      inferredRaw,
    );
    const dailyRows = rows<{ day: string; cnt: string | number }>(dailyRaw);
    const recipientRows = rows<{
      sent_at: string;
      message_id: string;
      telegram_username: string | null;
      kommo_lead_id: string | number | null;
    }>(recipientRaw);
    const subRows = rows<{ status: string; suppressed: string | number; cnt: string | number }>(
      subRaw,
    );
    const subscriberRows = rows<{
      status: string;
      suppressed: string | number;
      anchor_at: string | null;
      termin_date: string | null;
      telegram_username: string | null;
      kommo_lead_id: string | number | null;
    }>(subscriberRaw);
    const healthRows = rows<{ status: string; cnt: string | number }>(healthRaw);

    // --- этапы (union ключей deliveries + interactions + inferred) ---
    // Прямые клики и восстановленные объединяются ПО ПОЛЬЗОВАТЕЛЮ (Set uid):
    // юзер, который и кликнул, и тренировался в день доставки, считается один раз.
    const byMsg = new Map<string, BroadcastStageRow>();
    const rpClickUsers = new Map<string, Set<string>>();
    const rpDoneUsers = new Map<string, Set<string>>();
    const linkUsers = new Map<string, Set<string>>();
    const addTo = (map: Map<string, Set<string>>, msg: string, uid: string) => {
      let s = map.get(msg);
      if (!s) {
        s = new Set<string>();
        map.set(msg, s);
      }
      s.add(uid);
    };
    const ensure = (id: string): BroadcastStageRow => {
      let m = byMsg.get(id);
      if (!m) {
        m = { messageId: id, sent: 0, rpClick: 0, rpDone: 0, link: 0 };
        byMsg.set(id, m);
      }
      return m;
    };
    for (const r of sentRows) {
      if (r.message_id) ensure(String(r.message_id)).sent = Number(r.cnt) || 0;
    }
    for (const r of interRows) {
      if (!r.message_id) continue;
      const msg = String(r.message_id);
      ensure(msg);
      if (r.action === "roleplay_click") addTo(rpClickUsers, msg, r.uid);
      else if (r.action === "roleplay_completed") addTo(rpDoneUsers, msg, r.uid);
      else if (r.action === "link_click") addTo(linkUsers, msg, r.uid);
    }
    // Восстановленные — только для сообщений, у которых по контенту ЕСТЬ кнопка
    // ролевки (иначе тренировка в день «текстового» сообщения — совпадение).
    // Для кампаний без копии контента применяем ко всем (лучше пере-, чем недо-).
    const contentKnown = hasCampaignContent(selected);
    const hasRpButton = (msg: string): boolean => {
      if (!contentKnown) return true;
      const c = getMessageContent(selected, msg);
      return !!c && c.buttons.some((b) => b.type === "roleplay");
    };
    for (const r of inferredRows) {
      if (!r.message_id) continue;
      const msg = String(r.message_id);
      if (!hasRpButton(msg)) continue;
      ensure(msg);
      addTo(rpClickUsers, msg, r.uid);
      if (r.finished) addTo(rpDoneUsers, msg, r.uid);
    }
    for (const [msg, m] of byMsg) {
      m.rpClick = rpClickUsers.get(msg)?.size ?? 0;
      m.rpDone = rpDoneUsers.get(msg)?.size ?? 0;
      m.link = linkUsers.get(msg)?.size ?? 0;
    }
    const stages = Array.from(byMsg.values()).sort((a, b) =>
      a.messageId.localeCompare(b.messageId),
    );

    // --- по дням ---
    const daily: BroadcastDailyPoint[] = dailyRows.map((r) => ({
      day: String(r.day),
      sent: Number(r.cnt) || 0,
    }));

    // --- имена сделок из analytics (одним запросом для получателей + подписчиков) ---
    const recipientsTruncated = recipientRows.length > RECIPIENTS_CAP;
    const capped = recipientRows.slice(0, RECIPIENTS_CAP);
    const leadIds = [...capped, ...subscriberRows]
      .map((r) => Number(r.kommo_lead_id))
      .filter((n) => Number.isInteger(n) && n > 0);
    const names = await resolveLeadNames(leadIds);

    // --- подписчики ---
    const subscribers: BroadcastSubscriber[] = subscriberRows.map((r) => {
      const leadId =
        r.kommo_lead_id != null && Number.isInteger(Number(r.kommo_lead_id))
          ? Number(r.kommo_lead_id)
          : null;
      return {
        status: String(r.status),
        suppressed: Number(r.suppressed) === 1,
        telegramUsername: r.telegram_username ?? null,
        leadId,
        leadName: leadId ? names.get(leadId) ?? null : null,
        anchorAt: r.anchor_at ?? null,
        terminDate: r.termin_date ?? null,
      };
    });

    const recipients: BroadcastRecipient[] = capped.map((r) => {
      const leadId =
        r.kommo_lead_id != null && Number.isInteger(Number(r.kommo_lead_id))
          ? Number(r.kommo_lead_id)
          : null;
      return {
        sentAt: String(r.sent_at),
        messageId: String(r.message_id),
        telegramUsername: r.telegram_username ?? null,
        leadId,
        leadName: leadId ? names.get(leadId) ?? null : null,
      };
    });

    // --- сводка подписок ---
    const subscriptions: BroadcastSubscriptionSummary = { ...EMPTY_SUBS };
    for (const r of subRows) {
      const cnt = Number(r.cnt) || 0;
      subscriptions.total += cnt;
      if (r.status === "active") subscriptions.active += cnt;
      else if (r.status === "completed") subscriptions.completed += cnt;
      else if (r.status === "excluded") subscriptions.excluded += cnt;
      if (Number(r.suppressed) === 1) subscriptions.suppressed += cnt;
    }

    // --- здоровье доставки ---
    const delivery: BroadcastDeliveryHealth = { ...EMPTY_DELIVERY };
    for (const r of healthRows) {
      const cnt = Number(r.cnt) || 0;
      delivery.total += cnt;
      if (r.status === "pending") delivery.pending += cnt;
      else if (r.status === "sent") delivery.sent += cnt;
      else if (r.status === "skipped") delivery.skipped += cnt;
      else if (r.status === "failed") delivery.failed += cnt;
    }

    return {
      available: true,
      campaignId: selected,
      campaigns,
      range: { from, to },
      stages,
      daily,
      recipients,
      recipientsTruncated,
      subscriptions,
      subscribers,
      delivery,
    };
  } catch (e) {
    console.error(
      "[broadcast] getBroadcastStats failed (non-fatal):",
      e instanceof Error ? e.message : e,
    );
    return emptyStats();
  }
}
