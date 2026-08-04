// Общая серверная сборка «детализации оценки» звонка. Вынесена из
// api/okk/calls/[callId] и api/calls/[callId], чтобы один и тот же payload
// могли получать: (а) detail-роуты для модалок, (б) снапшоты вкладки «Жалобы»
// (snapshotEval → замороженный jsonb eval_before/eval_after). Замораживать
// нужно потому, что переоценка в ОКК перезаписывает строку evaluations
// (UPSERT, одна строка на звонок), а cleanup-job со временем удаляет старые
// звонки целиком — «оценку на момент подачи жалобы» иначе не восстановить.

import { eq, desc, sql } from "drizzle-orm";
import { getOkkDbForDepartment } from "@/lib/db/okk";
import { okkCalls, okkEvaluations, TranscriptSpeakerSegment } from "@/lib/db/schema-okk";
import { getDbForDepartment } from "@/lib/db/index";
import { d1Calls, d1Users, r1Calls, r1Users } from "@/lib/db/schema-existing";
import { formatCallDate, fmtLocalDate, addDaysCivil, APP_TZ } from "@/lib/utils/date";

export type Department = "b2g" | "b2b";

// Kommo custom field «Категория лида» (A/B/C). Аккаунт один на оба отдела
// (sternmeister.kommo.com), id стабилен; ключи в kommo_custom_fields имеют
// вид field_<id> (пишет OKK-сервис).
const KOMMO_LEAD_CATEGORY_FIELD = "field_866934";

// Движок OKK дописывает в начало причины служебный маркер «[Auto-override…]»,
// когда сам снимает критерий (call_type/follow-up-оверрайды). Для читателей
// это шум — неприменимость и так видна по applicable/«Пусто». Срезаем на
// уровне API, чтобы чисто было у ВСЕХ потребителей (модалка Аналитики,
// модалка ОКК в page.tsx, снапшоты «Жалоб», будущие экспорты).
export function stripEngineTags(feedback: string): string {
  return feedback.replace(/^\s*(\[Auto-override[^\]]*\]\s*)+/i, "").trim();
}

// ─── Helper: кто из спикеров — менеджер (Продавец) ───────────────────────────
// Спикеры помечены "A"/"B" диаризацией; сама метка не привязана к роли.
// Порядок определения (от надёжного к запасному):
//   1) seller_speaker из оценки (OKK определил роль по СОДЕРЖАНИЮ при
//      скоринге — тот же источник, что и балл) — если метка реальна;
//   2) маркеры в репликах: имя менеджера в самопредставлении + «Sternmeister /
//      приёмной комиссии / специалист»;
//   3) эвристика по направлению звонка (историческое поведение, ненадёжна:
//      ломается при direction=unknown и когда продавец здоровается первым).
const SELLER_MARKERS = [
  /sternmeister/i, /штерн/i, /штермайстер/i, /штур?ман\s*мастер/i,
  /при[её]мной\s+комисс/i, /при[её]мн/i, /специалист/i,
];
export function resolveManagerSpeaker(
  utterances: TranscriptSpeakerSegment[],
  direction: string | null,
  sellerSpeaker?: string | null,
  managerName?: string | null,
): string {
  const labels = new Set(utterances.map((u) => u.speaker));

  // 1) из оценки
  if (sellerSpeaker && labels.has(sellerSpeaker)) return sellerSpeaker;

  // 2) маркеры в репликах
  // Экранируем имя: из CRM может прийти «Иван (стажёр)» и т.п. — без escape
  // спецсимвол уронил бы RegExp в SyntaxError и весь роут в 500.
  const firstNameRaw = (managerName || "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  const firstName = firstNameRaw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const introRe = firstNameRaw.length >= 3 ? new RegExp(`(меня зовут|это|зовут)\\s+${firstName}\\b`, "i") : null;
  const scores: Record<string, number> = {};
  utterances.forEach((u, i) => {
    const t = u.text || "";
    if (introRe && i < 12 && introRe.test(t.toLowerCase())) {
      scores[u.speaker] = (scores[u.speaker] || 0) + 3;
    }
    if (SELLER_MARKERS.some((re) => re.test(t))) scores[u.speaker] = (scores[u.speaker] || 0) + 1;
  });
  const ranked = Object.keys(scores).sort((a, b) => scores[b] - scores[a]);
  if (ranked[0] && scores[ranked[0]] >= 3 && scores[ranked[0]] > (scores[ranked[1]] ?? 0)) {
    return ranked[0];
  }

  // 3) эвристика по направлению (последний резерв)
  const isOutbound = direction !== "inbound"; // default outbound
  const firstSpeaker = utterances[0]?.speaker ?? "A";
  return isOutbound
    ? (utterances.find((u) => u.speaker !== firstSpeaker)?.speaker ?? "B")
    : firstSpeaker;
}

export function buildSpeakerTranscript(
  speakersRaw: unknown,
  direction: string | null,
  sellerSpeaker?: string | null,
  managerName?: string | null,
): string {
  // transcript_speakers is stored as { utterances: [...] }
  const utterances = parseUtterances(speakersRaw);

  if (utterances.length === 0) return "";

  const managerSpeaker = resolveManagerSpeaker(utterances, direction, sellerSpeaker, managerName);

  return utterances
    .map((u) => {
      const role = u.speaker === managerSpeaker ? "[Продавец]" : "[Клиент]";
      return `${role}: ${u.text}`;
    })
    .join("\n");
}

// transcript_speakers хранится как массив ЛИБО как { utterances: [...] }.
function parseUtterances(raw: unknown): TranscriptSpeakerSegment[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw as TranscriptSpeakerSegment[];
  if (typeof raw === "object" && "utterances" in (raw as Record<string, unknown>)) {
    return ((raw as { utterances: TranscriptSpeakerSegment[] }).utterances) ?? [];
  }
  return [];
}

// ─── Helper: на какой секунде звучал критерий ────────────────────────────────
// С ~июля 2026 OKK-движок для составных критериев (несколько реплик подряд)
// сам вклеивает в quote таймкоды вида «[MM:SS] – Роль – текст», поэтому в
// приоритете — распарсить первый такой таймкод из самой цитаты (он точный,
// это данные диаризации на стороне OKK). Если таймкода в цитате нет (старый
// формат — дословная вырезка одной реплики без префикса), матчим текст к
// диаризованному транскрипту (utterances со start/end): сначала прямое
// вхождение, затем — лучшее пересечение по словам. Нет цитаты / нет
// совпадения → null (таймкод не показываем).
const QUOTE_TIMECODE_RE = /\[(\d{1,2}):(\d{2})(?::(\d{2}))?\]/;

function normQuoteText(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export function findQuoteStartSec(
  quote: string,
  utterances: TranscriptSpeakerSegment[],
  toSec: (raw: number) => number,
  /** Длительность звонка (сек) — sanity-потолок для таймкода из quote. */
  maxSec?: number,
): number | null {
  if (!quote) return null;
  const tc = quote.match(QUOTE_TIMECODE_RE);
  if (tc) {
    const [, a, b, c] = tc;
    const sec = c != null ? Number(a) * 3600 + Number(b) * 60 + Number(c) : Number(a) * 60 + Number(b);
    // Таймкод не должен превышать длительность звонка (+5с на округление) —
    // иначе это, вероятно, битый таймкод от движка либо 2-сегментный HH:MM,
    // ошибочно прочитанный как MM:SS. В обоих случаях лучше откатиться на
    // fuzzy-матчинг ниже, чем показать абсурдное время.
    if (maxSec == null || sec <= maxSec + 5) {
      return Math.max(0, sec);
    }
  }
  if (utterances.length === 0) return null;
  const q = normQuoteText(quote);
  if (q.length < 3) return null;
  const qWords = q.split(" ").filter(Boolean);
  const probe = qWords.slice(0, Math.min(8, qWords.length)).join(" ");
  // 1) Прямое вхождение (цитата — verbatim-вырезка реплики, либо наоборот).
  for (const u of utterances) {
    const ut = normQuoteText(u.text);
    if (!ut) continue;
    if (ut.includes(probe) || (probe.length >= 6 && probe.includes(ut)) || ut.includes(q) || q.includes(ut)) {
      return Math.max(0, Math.floor(toSec(u.start)));
    }
  }
  // 2) Fallback — реплика с наибольшим пересечением по словам (≥3 общих).
  const qSet = new Set(qWords);
  let best: { sec: number; score: number } | null = null;
  for (const u of utterances) {
    const uw = normQuoteText(u.text).split(" ").filter(Boolean);
    if (uw.length === 0) continue;
    let overlap = 0;
    for (const w of uw) if (qSet.has(w)) overlap++;
    const score = overlap / uw.length;
    if (overlap >= 3 && (best === null || score > best.score)) {
      best = { sec: Math.max(0, Math.floor(toSec(u.start))), score };
    }
  }
  return best ? best.sec : null;
}

// ─── ОКК: полная детализация звонка (без voiceFeedback/feedbackTask) ─────────
// Возвращает то, что раньше собирал api/okk/calls/[callId] inline; роут
// добавляет сверху только «Разбор ОС» (voiceFeedback/feedbackTask). null —
// звонок не найден.
export async function fetchOkkCallDetail(department: Department, callId: string) {
  const db = getOkkDbForDepartment(department);

  // ── Single call LEFT JOIN evaluation ─────────────────────
  const rows = await db
    .select({
      // Call fields
      id: okkCalls.id,
      managerId: okkCalls.managerId,
      managerName: okkCalls.managerName,
      durationSeconds: okkCalls.durationSeconds,
      recordingUrl: okkCalls.recordingUrl,
      transcript: okkCalls.transcript,
      transcriptSpeakers: okkCalls.transcriptSpeakers,
      direction: okkCalls.direction,
      kommoLeadUrl: okkCalls.kommoLeadUrl,
      callCreatedAt: okkCalls.callCreatedAt,
      // Метаданные для «Детализации оценок» (Spellit-набор)
      contactPhone: okkCalls.contactPhone,
      callgearCallId: okkCalls.callgearCallId,
      kommoLeadName: okkCalls.kommoLeadName,
      kommoStatusName: okkCalls.kommoStatusName,
      initialKommoStatusName: okkCalls.initialKommoStatusName,
      // Из jsonb тянем только нужный скаляр — блоб custom fields бывает
      // многокилобайтным, а нужен один ключ.
      leadCategory: sql<string | null>`${okkCalls.kommoCustomFields} ->> ${KOMMO_LEAD_CATEGORY_FIELD}`,
      // Evaluation fields (may be null when no evaluation exists yet)
      totalScore: okkEvaluations.totalScore,
      evaluationJson: okkEvaluations.evaluationJson,
      overrideMetadata: okkEvaluations.overrideMetadata,
      mistakes: okkEvaluations.mistakes,
      recommendations: okkEvaluations.recommendations,
      evaluationCreatedAt: okkEvaluations.createdAt,
    })
    .from(okkCalls)
    .leftJoin(okkEvaluations, eq(okkCalls.id, okkEvaluations.callId))
    .where(eq(okkCalls.id, callId))
    .orderBy(desc(okkEvaluations.createdAt))
    .limit(1);

  if (rows.length === 0) return null;

  const row = rows[0];

  // ── Duration formatting ───────────────────────────────────
  const dSec = row.durationSeconds || 0;
  const mins = Math.floor(dSec / 60);
  const secs = dSec % 60;

  // ── Client scoring and narrative summary from evaluation JSON ─────────
  const evalJson = row.evaluationJson as Record<string, unknown> | null;
  const clientScoring =
    (evalJson?.client_scoring as unknown) ||
    null;

  // Narrative summary string from evaluationJson.summary
  const evalSummary =
    typeof evalJson?.summary === "string" ? evalJson.summary : null;

  // Raw max score for displaying fraction (e.g. "8/33 (24%)")
  const totalMaxScore =
    typeof evalJson?.total_max_score === "number" ? evalJson.total_max_score : null;

  // ── Utterances (со start/end) для таймкодов критериев ─────
  const utterances = parseUtterances(row.transcriptSpeakers as unknown);
  // Единицы start/end у STT — секунды, но подстрахуемся: если максимум сильно
  // превышает длительность звонка, значит миллисекунды → делим на 1000.
  const maxEnd = utterances.reduce((m, u) => Math.max(m, u.end ?? u.start ?? 0), 0);
  const isMs = dSec > 0 && maxEnd > dSec * 3;
  const toSec = (raw: number) => (isMs ? raw / 1000 : raw);

  // Структурированный транскрипт для чат-вида: спикер + текст + секунда
  // старта реплики (таймкод MM:SS на клиенте).
  const sellerSpeaker = row.overrideMetadata?.seller_speaker ?? null;
  const managerSpeaker = resolveManagerSpeaker(utterances, row.direction, sellerSpeaker, row.managerName);
  const transcriptTurns = utterances
    .filter((u) => u.text && u.text.trim())
    .map((u) => ({
      speaker: (u.speaker === managerSpeaker ? "manager" : "client") as "manager" | "client",
      text: u.text,
      atSecond: typeof u.start === "number" ? Math.max(0, Math.floor(toSec(u.start))) : null,
    }));

  // ── Evaluation blocks with full criteria ──────────────────
  // Includes: name, score, maxScore, and per-criterion feedback/quote
  const blocks = (row.evaluationJson?.blocks ?? [])
    .filter((b) => (b.criteria && b.criteria.length > 0) || b.feedback)
    .map((b, i) => ({
      id: String(i),
      name: b.name || "",
      score: b.block_score ?? b.score ?? 0,
      maxScore: b.max_block_score ?? b.max_score ?? 0,
      criteria: b.criteria
        ? b.criteria.map((c, idx) => ({
            id: idx + 1,
            name: c.name || "",
            score: (() => {
              if (typeof c.score === "number") return c.score;
              if ((c.score as unknown) === "1") return 1;
              if ((c.score as unknown) === "0") return 0;
              console.warn(`[OKK] Unexpected criterion score: ${JSON.stringify(c.score)} for "${c.name}"`);
              return null;
            })(),
            maxScore:
              typeof c.max_score === "number"
                ? c.max_score
                : c.max_score === 1
                  ? 1
                  : 0,
            feedback: stripEngineTags(c.feedback || ""),
            quote: c.quote || "",
            applicable: c.applicable !== false,
            // Секунда старта реплики, к которой относится цитата (MM:SS на клиенте).
            atSecond: findQuoteStartSec(c.quote || "", utterances, toSec, dSec || undefined),
          }))
        : [],
      // Derived summary of failed binary criteria for quick display
      // «Пусто» (applicable=false) — не провал: в сводку не включаем.
      // Унаследованный провал (inherited_from_call_id, OKK с 2026-07-07) —
      // ошибка ПРОШЛОГО звонка клиента, вошедшая в балл этого: помечаем,
      // чтобы сводка не приписывала её текущему звонку (полная атрибуция —
      // в feedback критерия ниже).
      feedback: b.criteria
        ? b.criteria
            .filter((c) => c.score === 0 && c.max_score > 0 && c.applicable !== false)
            .map((c) => `❌ ${c.name}${c.inherited_from_call_id ? " (унаследовано из прошлого звонка)" : ""}`)
            .join("\n")
        : b.feedback || "",
    }));

  // ── Метаданные звонка для «Детализации оценок» ────────────
  // Неделя звонка (Пн–Вс), формат Spellit «YYYY-MM-DD - YYYY-MM-DD».
  // Через civil-хелперы date.ts (правило CLAUDE.md №1): fmtLocalDate даёт
  // календарную дату в APP_TZ, дальше чистая civil-арифметика без TZ.
  const week = (() => {
    if (!row.callCreatedAt) return null;
    const civil = fmtLocalDate(row.callCreatedAt); // YYYY-MM-DD
    const [y, m, d] = civil.split("-").map(Number);
    const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=Вс
    const monday = addDaysCivil(civil, -((dow + 6) % 7));
    return `${monday} - ${addDaysCivil(monday, 6)}`;
  })();

  const berlinDateTime = (d: Date | null) =>
    d
      ? d.toLocaleString("ru-RU", {
          timeZone: APP_TZ,
          day: "2-digit", month: "2-digit", year: "numeric",
          hour: "2-digit", minute: "2-digit",
        })
      : null;

  const meta = {
    clientName: row.kommoLeadName || null,
    phone: row.contactPhone || null,
    // Источник CDR: префикс ct- = CloudTalk, прочие внешние id = CallGear.
    source: row.callgearCallId
      ? (row.callgearCallId.startsWith("ct-") ? "CloudTalk" : "CallGear")
      : null,
    leadCategory: row.leadCategory ?? null,
    stageAtCallStart: row.initialKommoStatusName || null,
    stageAtPickup: row.kommoStatusName || null,
    week,
    callDateTime: berlinDateTime(row.callCreatedAt),
    analyzedAt: berlinDateTime(row.evaluationCreatedAt),
  };

  // ── Build final call object ───────────────────────────────
  return {
    id: row.id,
    name: row.managerName || "—",
    avatarUrl: "",
    callDuration: `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`,
    date: formatCallDate(row.callCreatedAt),
    score: row.totalScore || 0,
    hasRecording: !!row.recordingUrl,
    audioUrl: row.recordingUrl
      ? `/api/okk/audio/${row.id}?dept=${department}`
      : "#",
    kommoUrl: row.kommoLeadUrl || "",
    transcript:
      buildSpeakerTranscript(row.transcriptSpeakers, row.direction, sellerSpeaker, row.managerName) ||
      row.transcript ||
      "",
    transcriptTurns,
    aiFeedback: row.recommendations || "",
    summary: row.mistakes || "",
    evalSummary: evalSummary || "",
    totalMaxScore: totalMaxScore ?? undefined,
    // Сырой набранный балл — сумма скоринговых блоков. Клиент показывает
    // его как X/Y вместо лоссивного восстановления из округлённого %.
    totalRawScore: blocks.reduce((a, b) => a + (b.maxScore > 0 ? b.score : 0), 0),
    blocks,
    clientScoring,
    meta,
  };
}

// ─── Ролевки (D1/R1): полная детализация звонка (без voiceFeedback) ──────────
// То, что раньше собирал api/calls/[callId] inline; роут добавляет сверху
// голосовой разбор (voiceFeedback, только b2g). null — звонок не найден.
export async function fetchRoleplayCallDetail(department: Department, callId: string) {
  const { calls, users } =
    department === "b2g"
      ? { calls: d1Calls, users: d1Users }
      : { calls: r1Calls, users: r1Users };
  const db = getDbForDepartment(department);

  const rows = await db
    .select({
      id: calls.id,
      userId: calls.userId,
      startedAt: calls.startedAt,
      endedAt: calls.endedAt,
      durationSeconds: calls.durationSeconds,
      transcript: calls.transcript,
      score: calls.score,
      mistakes: calls.mistakes,
      recommendations: calls.recommendations,
      recordingPath: calls.recordingPath,
      evaluationJson: calls.evaluationJson,
      userName: users.name,
      userTelegramUsername: users.telegramUsername,
    })
    .from(calls)
    .leftJoin(users, eq(calls.userId, users.id))
    .where(eq(calls.id, callId))
    .limit(1);

  if (rows.length === 0) return null;

  const call = rows[0];

  // Длительность звонка
  const duration = call.durationSeconds || 0;
  const minutes = Math.floor(duration / 60);
  const seconds = duration % 60;

  // Преобразование блоков оценки из evaluationJson
  const blocks = (call.evaluationJson?.blocks || [])
    .filter((b) => (b.criteria && b.criteria.length > 0) || (b as any).feedback)
    .map((b, i) => ({
      id: String(i),
      name: b.name || "",
      score: b.block_score ?? 0,
      maxScore: b.max_block_score ?? 0,
      criteria: b.criteria
        ? b.criteria.map((c: any, idx: number) => ({
            id: idx + 1,
            name: c.name || "",
            score:
              typeof c.score === "number"
                ? c.score
                : c.score === "1"
                ? 1
                : c.score === "0"
                ? 0
                : -1,
            maxScore:
              typeof c.max_score === "number"
                ? c.max_score
                : c.max_score === 1
                ? 1
                : 0,
            feedback: c.feedback || "",
            quote: c.quote || "",
          }))
        : [],
      feedback: b.criteria
        ? b.criteria
            .filter((c: any) => c.score === 0 && c.max_score > 0)
            .map((c: any) => `❌ ${c.name}`)
            .join("\n")
        : "",
    }));

  // Extract mistakes/recommendations from evaluation blocks if text fields are stubs
  const isStub = (s: string | null) => !s || s === "См. детальную оценку";
  let mistakesText = call.mistakes || "";
  let recommendationsText = call.recommendations || "";

  if (isStub(mistakesText) && call.evaluationJson?.blocks) {
    const errorLines: string[] = [];
    let num = 1;
    for (const b of call.evaluationJson.blocks) {
      if (!b.criteria) continue;
      for (const c of b.criteria) {
        if (c.score === 0 && c.max_score > 0 && c.feedback) {
          errorLines.push(`${num}. ${c.name}: ${c.feedback}`);
          num++;
        }
      }
    }
    if (errorLines.length > 0) mistakesText = errorLines.join("\n\n");
  }

  if (isStub(recommendationsText) && call.evaluationJson?.blocks) {
    const recBlock = call.evaluationJson.blocks.find((b) => b.name === "Рекомендации");
    if (recBlock?.criteria) {
      const lines: string[] = [];
      let num = 1;
      for (const c of recBlock.criteria) {
        if (c.feedback) {
          lines.push(`${num}. ${c.name}: ${c.feedback}`);
          num++;
        }
      }
      if (lines.length > 0) recommendationsText = lines.join("\n\n");
    }
  }

  // Extract narrative summary and raw max score from evaluationJson
  const evalJsonRaw = call.evaluationJson as Record<string, unknown> | null;
  const evalSummary =
    typeof evalJsonRaw?.summary === "string" ? evalJsonRaw.summary : "";
  const totalMaxScore =
    typeof evalJsonRaw?.total_max_score === "number"
      ? evalJsonRaw.total_max_score
      : undefined;

  return {
    id: call.id,
    name: call.userName || "Unknown",
    avatarUrl: `https://i.pravatar.cc/150?u=${call.userTelegramUsername || call.userId}`,
    callDuration: `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`,
    date: formatCallDate(call.startedAt),
    score: call.score || 0,
    totalMaxScore,
    hasRecording: !!call.recordingPath,
    audioUrl: call.recordingPath ? `/api/audio/${call.id}?dept=${department}` : "#",
    kommoUrl: "#",
    transcript: call.transcript || "",
    aiFeedback: recommendationsText,
    summary: mistakesText,
    evalSummary,
    blocks,
  };
}

// ─── Замороженный снимок оценки для вкладки «Жалобы» ─────────────────────────
// Ровно те поля, что нужны EvalDetailView; транскрипт/аудио НЕ входят
// (размер jsonb). v — версия схемы снимка на случай будущих изменений.
export interface FrozenEvalCriterion {
  id: number; name: string; score: number | null; maxScore: number;
  feedback: string; quote: string; applicable?: boolean; atSecond?: number | null;
}
export interface FrozenEvalBlock {
  id: string; name: string; score: number; maxScore: number;
  criteria: FrozenEvalCriterion[]; feedback: string;
}
export interface FrozenEvalMeta {
  clientName: string | null; phone: string | null; source: string | null;
  leadCategory: string | null; stageAtCallStart: string | null; stageAtPickup: string | null;
  week: string | null; callDateTime: string | null; analyzedAt: string | null;
}
export interface FrozenEvalPayload {
  v: 1;
  blocks: FrozenEvalBlock[];
  meta?: FrozenEvalMeta;
  kommoUrl?: string;
  callDuration: string;
  manager: string;
  score: number;
  totalMaxScore?: number;
  totalRawScore?: number;
  snapshotAt: string; // ISO
}

// Снимает текущее состояние оценки звонка. null — звонок не найден ИЛИ у него
// (ещё/уже) нет детализации критериев: замораживать нечего. Ошибки БД НЕ
// глотает — обработка на вызывающей стороне (ingest не должен падать целиком).
export async function snapshotEval(opts: {
  callSource: "okk" | "ai";
  callId: string;
  department: Department;
}): Promise<{ score: number; payload: FrozenEvalPayload } | null> {
  const okkDetail =
    opts.callSource === "okk" ? await fetchOkkCallDetail(opts.department, opts.callId) : null;
  const roleplayDetail =
    opts.callSource === "ai" ? await fetchRoleplayCallDetail(opts.department, opts.callId) : null;
  const detail = okkDetail ?? roleplayDetail;
  if (!detail || !detail.blocks.length) return null;

  const payload: FrozenEvalPayload = {
    v: 1,
    blocks: detail.blocks,
    meta: okkDetail?.meta,
    kommoUrl: detail.kommoUrl && detail.kommoUrl !== "#" ? detail.kommoUrl : undefined,
    callDuration: detail.callDuration,
    manager: detail.name,
    score: detail.score,
    totalMaxScore: detail.totalMaxScore ?? undefined,
    totalRawScore: okkDetail?.totalRawScore,
    snapshotAt: new Date().toISOString(),
  };
  return { score: detail.score, payload };
}
