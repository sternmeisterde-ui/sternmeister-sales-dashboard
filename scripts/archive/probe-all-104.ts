// Across all 104 leads, count calls at lead level AND contact level + dur distribution.
import { kommoFetchPath } from "../src/lib/kommo/client";

async function main() {
  // Fetch all leads in window
  const out = new URLSearchParams();
  const statuses = [101935919, 104211575, 142, 143, 83873491, 90367079, 90367083, 90367087, 95514983, 95514987];
  for (let i = 0; i < statuses.length; i++) {
    out.append(`filter[statuses][${i}][pipeline_id]`, "10935879");
    out.append(`filter[statuses][${i}][status_id]`, String(statuses[i]));
  }
  out.set("filter[created_at][from]", "1778450400");
  out.set("filter[created_at][to]", "1778795999");
  out.set("with", "contacts");

  const leads: any[] = [];
  for (let p = 1; p <= 5; p++) {
    const data: any = await kommoFetchPath(`/leads?${out.toString()}&limit=250&page=${p}`);
    const batch = data?._embedded?.leads ?? [];
    if (!batch.length) break;
    leads.push(...batch);
    if (batch.length < 250) break;
  }
  console.log(`Total leads in window: ${leads.length}`);

  const allowed = new Set([744186,744188,744190,744192,744304,744312,744314,744316,744318,744320,744384,745292,745304,746174,746700,750386,753840,753842]);
  const filtered = leads.filter((l: any) => {
    const f = (l.custom_fields_values || []).find((c: any) => c.field_id === 879824);
    if (!f || !f.values?.length) return true;
    return f.values.some((v: any) => allowed.has(v.enum_id));
  });
  console.log(`After CF filter: ${filtered.length}`);

  let leadsWithLeadCalls = 0;
  let leadsWithContactCalls = 0;
  let totalLeadCalls = 0;
  let totalContactCalls = 0;
  const durBuckets = { "0s": 0, "1-30s": 0, "31s-1min": 0, "1-3min": 0, "3-5min": 0, "5-10min": 0, "10-20min": 0, ">20min": 0 };
  const callsWithLinks: Array<{ leadId: number, src: string, dur: number }> = [];

  for (let i = 0; i < filtered.length; i++) {
    const l = filtered[i];
    if (i % 20 === 0) console.log(`  ${i}/${filtered.length}...`);

    // Lead-level call notes
    const leadNotes: any = await kommoFetchPath(`/leads/${l.id}/notes?limit=250&filter[note_type][]=call_in&filter[note_type][]=call_out`);
    const leadCalls = leadNotes?._embedded?.notes ?? [];
    if (leadCalls.length > 0) leadsWithLeadCalls++;
    totalLeadCalls += leadCalls.length;
    for (const n of leadCalls) {
      const d = n.params?.duration || 0;
      if (n.params?.link) callsWithLinks.push({ leadId: l.id, src: 'lead', dur: d });
      if (d === 0) durBuckets["0s"]++;
      else if (d <= 30) durBuckets["1-30s"]++;
      else if (d <= 60) durBuckets["31s-1min"]++;
      else if (d <= 180) durBuckets["1-3min"]++;
      else if (d <= 300) durBuckets["3-5min"]++;
      else if (d <= 600) durBuckets["5-10min"]++;
      else if (d <= 1200) durBuckets["10-20min"]++;
      else durBuckets[">20min"]++;
    }

    // Contact-level call notes
    const contacts = l._embedded?.contacts ?? [];
    for (const c of contacts) {
      const cNotes: any = await kommoFetchPath(`/contacts/${c.id}/notes?limit=250&filter[note_type][]=call_in&filter[note_type][]=call_out`);
      const cCalls = cNotes?._embedded?.notes ?? [];
      if (cCalls.length > 0) leadsWithContactCalls++;
      totalContactCalls += cCalls.length;
      for (const n of cCalls) {
        const d = n.params?.duration || 0;
        if (n.params?.link) callsWithLinks.push({ leadId: l.id, src: `contact${c.id}`, dur: d });
        if (d === 0) durBuckets["0s"]++;
        else if (d <= 30) durBuckets["1-30s"]++;
        else if (d <= 60) durBuckets["31s-1min"]++;
        else if (d <= 180) durBuckets["1-3min"]++;
        else if (d <= 300) durBuckets["3-5min"]++;
        else if (d <= 600) durBuckets["5-10min"]++;
        else if (d <= 1200) durBuckets["10-20min"]++;
        else durBuckets[">20min"]++;
      }
    }
  }

  console.log(`\n=== Summary across ${filtered.length} leads ===`);
  console.log(`  ${leadsWithLeadCalls} leads have calls on the LEAD itself (total: ${totalLeadCalls})`);
  console.log(`  ${leadsWithContactCalls} (contact-instances, may double-count if multi-contact) have calls on CONTACTS (total: ${totalContactCalls})`);
  console.log(`\n=== Duration distribution ===`);
  for (const [k, v] of Object.entries(durBuckets)) console.log(`  ${k.padEnd(10)} ${v}`);
  console.log(`\n=== Calls with recording link, sorted by duration ===`);
  callsWithLinks.sort((a, b) => b.dur - a.dur);
  for (const c of callsWithLinks.slice(0, 30)) console.log(`  lead ${c.leadId} (${c.src}): ${Math.floor(c.dur / 60)}min ${c.dur % 60}s`);
  console.log(`  ... total ${callsWithLinks.length} calls with recordings`);
}
main().catch((e) => { console.error(e); process.exit(1); });
