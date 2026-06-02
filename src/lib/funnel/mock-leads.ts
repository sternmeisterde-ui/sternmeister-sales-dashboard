/**
 * Генератор моковых лидов для drill-down панели.
 * На этапе J заменится на реальный fetch к /api/funnel/cohorts/{id}/{week}/leads.
 */

export interface MockLead {
  leadId: number;
  name: string;
  kommoUrl: string;
}

const FIRST_NAMES = [
  "Анна",
  "Елена",
  "Мария",
  "Татьяна",
  "Юлия",
  "Ольга",
  "Дмитрий",
  "Александр",
  "Сергей",
  "Михаил",
  "Виктор",
  "Артём",
  "Кирилл",
  "Андрей",
  "Игорь",
  "Наталья",
  "Полина",
  "Светлана",
  "Денис",
  "Илья",
];

const LAST_NAMES = [
  "Иванов",
  "Петров",
  "Сидоров",
  "Кузнецов",
  "Смирнов",
  "Соколов",
  "Попов",
  "Лебедев",
  "Васильев",
  "Зайцев",
  "Морозов",
  "Новиков",
  "Волков",
  "Алексеев",
  "Лазарев",
  "Дерикова",
  "Сираждинова",
  "Зорина",
  "Айвазян",
  "Болтова",
];

const KOMMO_BASE = "https://sternmeister.kommo.com/leads/detail";

function pseudoRandom(seed: number): number {
  const x = Math.sin(seed * 9301 + 49297) * 233280;
  return x - Math.floor(x);
}

export function generateMockLeads(
  conversionId: string,
  weekStartIso: string,
  metric: "base" | "target",
  count: number
): MockLead[] {
  if (count <= 0) return [];
  // Детерминированный seed из параметров — одинаковый клик даёт одинаковый набор.
  const seedBase =
    conversionId.charCodeAt(1) * 1000 +
    Number(weekStartIso.slice(8, 10)) * 50 +
    (metric === "target" ? 7 : 13);
  const n = Math.min(count, 15); // не более 15 в попапе
  const out: MockLead[] = [];
  for (let i = 0; i < n; i++) {
    const r1 = pseudoRandom(seedBase + i);
    const r2 = pseudoRandom(seedBase + i * 7 + 3);
    const r3 = pseudoRandom(seedBase + i * 11 + 17);
    const first = FIRST_NAMES[Math.floor(r1 * FIRST_NAMES.length)];
    const last = LAST_NAMES[Math.floor(r2 * LAST_NAMES.length)];
    // Псевдо-leadId на основе seed — стабильный для одного и того же клика.
    const leadId = Math.floor(18_000_000 + r3 * 2_000_000);
    out.push({
      leadId,
      name: `${first} ${last}`,
      kommoUrl: `${KOMMO_BASE}/${leadId}`,
    });
  }
  return out;
}
