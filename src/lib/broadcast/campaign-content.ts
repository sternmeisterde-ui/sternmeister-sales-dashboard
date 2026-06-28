/**
 * Справочник СОДЕРЖАНИЯ кампаний рассылки — заголовок/текст/кнопки/«День N, слот»
 * каждого сообщения. База бота этого не хранит (только факты доставки), поэтому
 * контент копируется из репозитория бота:
 *   - v2 (актуальная): berater_bot/app/content/broadcast_campaign.json
 *   - v1 (старая): из git-истории бота (до коммита fa05060) → campaign-content-v1.json
 *
 * ⚠️ ДРИФТ: при изменении кампании в боте (новый текст / v3) добавь/обнови JSON-копию
 * и зарегистрируй её в RAW_CAMPAIGNS ниже. Цифры (sent/клики) всегда живые из БД —
 * устареть может только текст/набор сообщений. См. docs/DASHBOARD-RASSYLKA.md.
 *
 * Текст сообщений — наш собственный доверенный контент (HTML из кампании), не
 * пользовательский ввод; рендерится как разметка.
 */
import campaignV1 from "./campaign-content-v1.json";
import campaignV2 from "./campaign-content-v2.json";

export interface CampaignButton {
  label: string;
  type: "roleplay" | "url" | "manager" | string;
  level?: string | null;
  url?: string | null;
}

export interface CampaignMessageContent {
  id: string;
  title: string; // «Сообщение 1 — День 1, утром»
  dayOffset: number; // День N = dayOffset+1 от якоря
  slot: string; // morning | late_morning | afternoon | evening
  slotTime: string; // «10:00» и т.п.
  textHtml: string;
  buttons: CampaignButton[];
  mediaCount: number; // включая followups (видео/фото)
  hasFollowups: boolean;
}

interface RawMedia {
  kind?: string;
}
interface RawFollowup {
  media?: RawMedia[];
}
interface RawMessage {
  id: string;
  title?: string;
  day_offset?: number;
  slot?: string;
  text_html?: string;
  buttons?: Array<{ label?: string; type?: string; level?: string | null; url?: string | null }>;
  media?: RawMedia[];
  followups?: RawFollowup[];
}
interface RawCampaign {
  campaign_id: string;
  time_slots?: Record<string, string>;
  messages: RawMessage[];
}

const RAW_CAMPAIGNS = [campaignV1, campaignV2] as unknown as RawCampaign[];

function buildMap(c: RawCampaign): Map<string, CampaignMessageContent> {
  const slots = c.time_slots ?? {};
  const map = new Map<string, CampaignMessageContent>();
  for (const m of c.messages ?? []) {
    if (!m.id) continue;
    const followupMedia = (m.followups ?? []).reduce(
      (n, f) => n + (f.media?.length ?? 0),
      0,
    );
    map.set(m.id, {
      id: m.id,
      title: m.title ?? m.id,
      dayOffset: m.day_offset ?? 0,
      slot: m.slot ?? "",
      slotTime: (m.slot && slots[m.slot]) || "",
      textHtml: m.text_html ?? "",
      buttons: (m.buttons ?? []).map((b) => ({
        label: b.label ?? "",
        type: b.type ?? "url",
        level: b.level ?? null,
        url: b.url ?? null,
      })),
      mediaCount: (m.media?.length ?? 0) + followupMedia,
      hasFollowups: (m.followups?.length ?? 0) > 0,
    });
  }
  return map;
}

const BY_CAMPAIGN: Record<string, Map<string, CampaignMessageContent>> = Object.fromEntries(
  RAW_CAMPAIGNS.map((c) => [c.campaign_id, buildMap(c)]),
);

/**
 * Человеческое имя кампании для UI: termin_warmup_v2 → «Версия 2». Парсим хвост `_vN`,
 * иначе возвращаем сырой id. Не привязано к наличию контент-копии.
 */
export function campaignLabel(campaignId: string): string {
  const m = /_v(\d+)$/.exec(campaignId);
  return m ? `Версия ${m[1]}` : campaignId;
}

/** Контент сообщения по (campaignId, messageId). null — если кампании/сообщения нет в копии. */
export function getMessageContent(
  campaignId: string | null,
  messageId: string,
): CampaignMessageContent | null {
  if (!campaignId) return null;
  return BY_CAMPAIGN[campaignId]?.get(messageId) ?? null;
}

/** Есть ли у нас копия контента для кампании. */
export function hasCampaignContent(campaignId: string | null): boolean {
  return !!campaignId && campaignId in BY_CAMPAIGN;
}
