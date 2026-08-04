// Наполнение реестра жалоб (D1 complaints) из двух существующих механизмов
// подачи — ничего нового менеджерам не выдаём, агрегируем то, что уже работает:
//   • error_report — форма «Отправить жалобу» в попапе звонка →
//     evaluation_error_reports в Neon-базе «daily» (исторически b2g);
//   • bug_report — попап «Сообщить об ошибке» → bug_reports в D1
//     (исторически b2b; берём только строки менеджеров/тимлидов — репорты
//     админов/РОПов это настоящие баг-репорты, не жалобы).
//
// Два пути наполнения:
//   1) dual-write: POST-роуты источников зовут ingest* сразу после своей
//      legacy-вставки (сбой ingest НЕ роняет legacy-запись);
//   2) syncComplaints() — догоняющий синк (строки с created_at >= SINCE,
//      которых ещё нет в реестре); он же выполняет первичный бэкфилл августа.
//
// Снимок оценки «до» (eval_before) замораживается здесь же, в момент
// регистрации: переоценка в ОКК перезаписывает строку evaluations, ждать
// нельзя. Ошибка снимка не блокирует вставку жалобы.

import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { complaints, bugReports, masterManagers } from "@/lib/db/schema-existing";
import { getDailyDb } from "@/lib/db/daily-db";
import { snapshotEval, type Department } from "@/lib/eval/snapshot";

// Реестр ведём с 1 августа 2026 (решение владельца: глубокий бэкфилл не нужен,
// августовские жалобы ещё не разбирались).
export const COMPLAINTS_SINCE = "2026-08-01";

// ─── Матчинг менеджера к master_managers ─────────────────────────────────────
// Канонический трёхступенчатый порядок (как в /api/tracking): telegram-username
// (ключ логина) → kommo_user_id (здесь неприменим — источники его не хранят) →
// точное имя. session.userId не годится: может указывать на d1_users/r1_users.

function normTg(tg: string | null | undefined): string | null {
  const t = (tg || "").replace(/^@/, "").trim().toLowerCase();
  return t || null;
}

export interface ManagerRow {
  id: string;
  name: string;
  telegramUsername: string | null;
  isActive: boolean | null;
}

export async function getManagersForDept(department: Department): Promise<ManagerRow[]> {
  const rows = await db
    .select({
      id: masterManagers.id,
      name: masterManagers.name,
      telegramUsername: masterManagers.telegramUsername,
      isActive: masterManagers.isActive,
    })
    .from(masterManagers)
    .where(eq(masterManagers.department, department));
  // Активные — раньше в списке: при дублях имени матч заберёт живую строку.
  return rows.sort((a, b) => Number(b.isActive ?? false) - Number(a.isActive ?? false));
}

export function matchMasterManager(
  managers: ManagerRow[],
  opts: { telegram?: string | null; name?: string | null },
): ManagerRow | null {
  const tg = normTg(opts.telegram);
  if (tg) {
    const byTg = managers.find((m) => normTg(m.telegramUsername) === tg);
    if (byTg) return byTg;
  }
  const name = (opts.name || "").trim();
  if (name) {
    const byName = managers.find((m) => m.name === name);
    if (byName) return byName;
  }
  return null;
}

// ─── Ingest одной строки источника ───────────────────────────────────────────

export interface ErrorReportRow {
  id: string | number;
  call_id: string | null;
  created_at: Date | string;
  department: string | null; // 'b2g' | 'b2b' | 'unknown'
  source: string | null;     // 'okk' | 'ai'
  manager_name: string | null;
  manager_telegram: string | null;
  call_score: number | null;
  message: string;
}

// UUID-гейт: в call_id источника исторически могло попасть что угодно —
// не-UUID уронил бы запрос к D2/R2 (тип колонки uuid).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function ingestErrorReport(row: ErrorReportRow): Promise<void> {
  // Исторически все строки b2g; 'unknown' на всякий случай маппим туда же.
  const department: Department = row.department === "b2b" ? "b2b" : "b2g";
  const callSource: "okk" | "ai" = row.source === "ai" ? "ai" : "okk";
  const callId = row.call_id && UUID_RE.test(row.call_id) ? row.call_id : null;

  // Снимок «до» — best-effort: недоступность D2/R2 или удалённый звонок не
  // должны терять саму жалобу (балл на момент подачи всё равно есть в
  // call_score). Догоняющий синк снимок НЕ дочинит (ON CONFLICT DO NOTHING) —
  // это осознанный компромисс, детализация тогда недоступна.
  let evalBefore: Record<string, unknown> | null = null;
  let snapshotScore: number | null = null;
  if (callId) {
    try {
      const snap = await snapshotEval({ callSource, callId, department });
      if (snap) {
        evalBefore = snap.payload as unknown as Record<string, unknown>;
        snapshotScore = snap.score;
      }
    } catch (e) {
      console.error(`[complaints] snapshot before failed for call ${callId}:`, e);
    }
  }

  const managers = await getManagersForDept(department);
  const master = matchMasterManager(managers, {
    telegram: row.manager_telegram,
    name: row.manager_name,
  });

  await db
    .insert(complaints)
    .values({
      source: "error_report",
      sourceId: String(row.id),
      department,
      managerName: row.manager_name || master?.name || null,
      managerTelegram: normTg(row.manager_telegram) ?? normTg(master?.telegramUsername),
      masterManagerId: master?.id ?? null,
      callId,
      callSource,
      text: row.message,
      filedAt: new Date(row.created_at),
      scoreBefore: row.call_score ?? snapshotScore,
      evalBefore,
    })
    .onConflictDoNothing({ target: [complaints.source, complaints.sourceId] });
}

export interface BugReportRow {
  id: string;
  reporterName: string;
  reporterRole: string;
  reporterDepartment: string;
  description: string;
  createdAt: Date | string | null;
}

// true — строка попала в реестр; false — пропущена (не менеджерская).
export async function ingestBugReport(row: BugReportRow): Promise<boolean> {
  // Только менеджеры/тимлиды: их «Сообщить об ошибке» на практике — жалобы
  // (см. dev_docs OKK-репо: разборы b2b идут из bug_reports). Строки
  // admin/rop — настоящие баг-репорты дашборда, в реестр не попадают.
  if (row.reporterRole !== "manager" && row.reporterRole !== "teamlead") return false;

  const department: Department = row.reporterDepartment === "b2b" ? "b2b" : "b2g";
  const managers = await getManagersForDept(department);
  const master = matchMasterManager(managers, { name: row.reporterName });

  await db
    .insert(complaints)
    .values({
      source: "bug_report",
      sourceId: String(row.id),
      department,
      managerName: row.reporterName,
      managerTelegram: normTg(master?.telegramUsername),
      masterManagerId: master?.id ?? null,
      callId: null,
      callSource: null,
      text: row.description,
      filedAt: row.createdAt ? new Date(row.createdAt) : new Date(),
      scoreBefore: null,
      evalBefore: null,
    })
    .onConflictDoNothing({ target: [complaints.source, complaints.sourceId] });
  return true;
}

// ─── Догоняющий синк ─────────────────────────────────────────────────────────
// Подтягивает строки источников (created_at >= SINCE), которых ещё нет в
// реестре: первичный бэкфилл августа + ремонт пропусков dual-write (деплой,
// сбой ingest). Лимит новых строк за прогон ограничивает время GET-запроса,
// который его запускает, — хвост доберут следующие прогоны.

const SYNC_THROTTLE_MS = 60_000;
const MAX_NEW_PER_SOURCE = 10;

let lastSyncStartedAt = 0;
let syncInFlight = false;

export async function syncComplaints(): Promise<void> {
  // Ключи уже зарегистрированных жалоб (реестр мал — сотни строк).
  const existing = await db
    .select({ source: complaints.source, sourceId: complaints.sourceId })
    .from(complaints);
  const seen = new Set(existing.map((r) => `${r.source}:${r.sourceId}`));

  // 1) evaluation_error_reports (Neon «daily»). Отсутствие DAILY_DATABASE_URL
  //    или недоступность базы — не фатально для второго источника.
  try {
    const dailyDb = getDailyDb();
    const res = await dailyDb.execute(sql`
      SELECT id, call_id, created_at, department, source,
             manager_name, manager_telegram, call_score, message
      FROM evaluation_error_reports
      WHERE created_at >= ${COMPLAINTS_SINCE}
      ORDER BY created_at
    `);
    const rows = (res.rows ?? []) as unknown as ErrorReportRow[];
    let ingested = 0;
    for (const row of rows) {
      if (seen.has(`error_report:${row.id}`)) continue;
      if (ingested >= MAX_NEW_PER_SOURCE) break;
      await ingestErrorReport(row);
      ingested++;
    }
  } catch (e) {
    console.error("[complaints] error_report catch-up failed:", e);
  }

  // 2) bug_reports (D1), только менеджеры/тимлиды.
  try {
    const rows = await db
      .select({
        id: bugReports.id,
        reporterName: bugReports.reporterName,
        reporterRole: bugReports.reporterRole,
        reporterDepartment: bugReports.reporterDepartment,
        description: bugReports.description,
        createdAt: bugReports.createdAt,
      })
      .from(bugReports)
      .where(
        and(
          gte(bugReports.createdAt, new Date(`${COMPLAINTS_SINCE}T00:00:00Z`)),
          inArray(bugReports.reporterRole, ["manager", "teamlead"]),
        ),
      );
    let ingested = 0;
    for (const row of rows) {
      if (seen.has(`bug_report:${row.id}`)) continue;
      if (ingested >= MAX_NEW_PER_SOURCE) break;
      await ingestBugReport(row);
      ingested++;
    }
  } catch (e) {
    console.error("[complaints] bug_report catch-up failed:", e);
  }
}

// Fire-and-forget из GET /api/complaints (stale-while-revalidate, как eNPS):
// ответ не ждёт синка, троттлинг ≥60с, одновременно — не более одного прогона.
export function maybeSyncComplaintsInBackground(): void {
  const now = Date.now();
  if (syncInFlight || now - lastSyncStartedAt < SYNC_THROTTLE_MS) return;
  lastSyncStartedAt = now;
  syncInFlight = true;
  syncComplaints()
    .catch((e) => console.error("[complaints] background sync failed:", e))
    .finally(() => {
      syncInFlight = false;
    });
}
