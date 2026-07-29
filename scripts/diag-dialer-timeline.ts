// Проверка шкалы «Активность → Дайлер»: строим её тем же кодом, что и API, и
// печатаем реальное берлинское время первого/последнего звонка + куда легли
// цветные сегменты. Результат НЕ должен зависеть от TZ процесса (created_at в
// analytics.* — naive UTC, см. parseAnalyticsTs). READ-ONLY.
//   npx tsx scripts/diag-dialer-timeline.ts 2026-07-29

import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });
import dns from "node:dns";
import net from "node:net";
dns.setDefaultResultOrder("ipv4first");
net.setDefaultAutoSelectFamily(true);
net.setDefaultAutoSelectFamilyAttemptTimeout(500);
import { getDialerCallEventsByMaster } from "../src/lib/daily/analytics-calls";
import { buildDialerTimeline, type DialerCall } from "../src/lib/tracking/timeline";
import { db as d1Db } from "../src/lib/db";
import { masterManagers } from "../src/lib/db/schema-existing";
import { and, eq, inArray } from "drizzle-orm";
import { tzOffsetMinutes } from "../src/lib/utils/date";

async function main() {
  const ymd = process.argv[2] ?? "2026-07-29";
  console.log("process.env.TZ =", process.env.TZ, "| local offset =", -new Date().getTimezoneOffset(), "мин");

  const dayUtc = new Date(`${ymd}T00:00:00Z`);
  const offset = tzOffsetMinutes(dayUtc, "Europe/Berlin");
  const rangeStart = new Date(dayUtc.getTime() - offset * 60_000);
  const rangeEnd = new Date(rangeStart.getTime() + 24 * 60 * 60_000);

  const rows = await d1Db
    .select({ id: masterManagers.id, name: masterManagers.name, line: masterManagers.line })
    .from(masterManagers)
    .where(
      and(
        eq(masterManagers.department, "b2g"),
        eq(masterManagers.isActive, true),
        inArray(masterManagers.role, ["manager", "teamlead", "rop"]),
      ),
    );
  const line1 = rows.filter((m) => m.line === "1");

  const events = await getDialerCallEventsByMaster(
    line1.map((m) => ({ id: m.id, name: m.name })),
    "b2g",
    Math.floor(rangeStart.getTime() / 1000),
    Math.floor(rangeEnd.getTime() / 1000),
  );

  const byMgr = new Map<string, DialerCall[]>();
  for (const ev of events) {
    const list = byMgr.get(ev.managerId) ?? [];
    list.push({
      startedAt: ev.createdAt,
      talkSec: ev.talkSec,
      waitSec: ev.waitSec,
      channel: ev.channel,
    });
    byMgr.set(ev.managerId, list);
  }

  const hhmm = (d: Date) =>
    new Intl.DateTimeFormat("ru-RU", {
      timeZone: "Europe/Berlin",
      hour: "2-digit",
      minute: "2-digit",
    }).format(d);

  for (const m of line1) {
    const calls = byMgr.get(m.id) ?? [];
    const tl = buildDialerTimeline({
      scheduleRow: { scheduleDate: ymd, scheduleValue: "8", shiftStartTime: null, shiftEndTime: null },
      dateISO: ymd,
      tzOffsetMinutes: offset,
      calls,
    });
    const painted = tl.segments.filter((s) => s.type !== "idle");
    const first = calls.length ? hhmm(new Date(Math.min(...calls.map((c) => c.startedAt.getTime())))) : "—";
    const last = calls.length ? hhmm(new Date(Math.max(...calls.map((c) => c.startedAt.getTime())))) : "—";
    console.log(
      `${m.name}: звонков ${calls.length} (первый ${first}, последний ${last}, Берлин) → ` +
        `цветных сегментов ${painted.length}, в дайлере ${tl.minutes.dialer}м, вне ${tl.minutes.manual}м, простой ${tl.minutes.idle}м`,
    );
    if (painted.length) {
      const toHm = (min: number) => {
        const t = 9 * 60 + min;
        return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
      };
      console.log(
        "   первые сегменты:",
        painted.slice(0, 5).map((s) => `${s.type} ${toHm(s.startMin)}–${toHm(s.endMin)}`).join(", "),
      );
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
