// Show all call notes per expected lead with their dates and durations.
import { kommoFetchPath } from "../src/lib/kommo/client";

const EXPECTED = [18808190, 14579346, 18594580, 16329684, 12689418, 14496730, 13026014, 14489140, 11555672];
const FROM = 1778450400; // 14.05.2026 00:00 Berlin
const TO = 1778795999;   // 17.05.2026 23:59 Berlin

async function main() {
  for (const id of EXPECTED) {
    let allNotes: any[] = [];
    for (let page = 1; page <= 10; page++) {
      const data: any = await kommoFetchPath(`/leads/${id}/notes?limit=250&page=${page}&filter[note_type][]=call_in&filter[note_type][]=call_out`);
      const batch = data?._embedded?.notes ?? [];
      if (!batch.length) break;
      allNotes = allNotes.concat(batch);
      if (batch.length < 250) break;
    }
    const inWin = allNotes.filter((n: any) => n.created_at >= FROM && n.created_at <= TO);
    console.log(`${id}: ${allNotes.length} call notes total, ${inWin.length} in 14-17.05.2026`);
    for (const n of allNotes) {
      const dur = n.params?.duration || 0;
      const link = n.params?.link ? "🔗" : "  ";
      const win = (n.created_at >= FROM && n.created_at <= TO) ? "✓" : " ";
      console.log(`  ${win} ${new Date(n.created_at * 1000).toISOString().slice(0, 16)}  ${String(dur).padStart(5)}s  ${link}  ${n.note_type}`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
