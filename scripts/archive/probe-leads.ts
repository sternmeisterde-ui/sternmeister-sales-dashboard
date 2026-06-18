// Probe expected leads to see which date field falls into 14-17.05.2026 window.
// Helps figure out what filter_date_switch should default to.
//   npx tsx --env-file=.env.local scripts/probe-leads.ts

import { kommoFetchPath } from "../src/lib/kommo/client";

const EXPECTED = [
  18808190, 14579346, 18594580, 16329684, 12689418,
  14496730, 13026014, 14489140, 11555672,
];

// Window: 14.05.2026 00:00 to 17.05.2026 23:59 Europe/Berlin
// parseDateBoundary gives Unix seconds; for Berlin in May = UTC+2 (DST)
// 14.05.2026 00:00 Berlin = 13.05.2026 22:00 UTC = 1778450400
// 17.05.2026 23:59 Berlin = 17.05.2026 21:59 UTC = 1778795999
const FROM = 1778450400;
const TO = 1778795999;

async function main() {
  for (const id of EXPECTED) {
    const lead: any = await kommoFetchPath(`/leads/${id}`);
    if (!lead) { console.log(`${id}: not found`); continue; }
    const inWindow = (ts: number) => ts >= FROM && ts <= TO ? "✓" : " ";
    const fmt = (ts: number | null | undefined) => ts ? new Date(ts * 1000).toISOString().slice(0, 16) : "—";
    console.log(
      `${id}  ` +
      `pipe=${lead.pipeline_id} status=${lead.status_id}  ` +
      `created=${fmt(lead.created_at)} ${inWindow(lead.created_at)}  ` +
      `updated=${fmt(lead.updated_at)} ${inWindow(lead.updated_at)}  ` +
      `closed=${fmt(lead.closed_at)} ${lead.closed_at ? inWindow(lead.closed_at) : "—"}`
    );
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
