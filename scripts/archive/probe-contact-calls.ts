// For 5 leads from the 104 set, get their contacts and check contact-level call notes.
import { kommoFetchPath } from "../src/lib/kommo/client";

async function main() {
  // Fetch first batch of leads from window
  const out = new URLSearchParams();
  const statuses = [101935919, 104211575, 142, 143, 83873491, 90367079, 90367083, 90367087, 95514983, 95514987];
  for (let i = 0; i < statuses.length; i++) {
    out.append(`filter[statuses][${i}][pipeline_id]`, "10935879");
    out.append(`filter[statuses][${i}][status_id]`, String(statuses[i]));
  }
  out.set("filter[created_at][from]", "1778450400");
  out.set("filter[created_at][to]", "1778795999");
  out.set("with", "contacts");

  const data: any = await kommoFetchPath(`/leads?${out.toString()}&limit=10&page=1`);
  const leads = data?._embedded?.leads ?? [];
  console.log(`Got ${leads.length} sample leads with contacts embedded`);

  for (const lead of leads.slice(0, 5)) {
    const contacts = lead._embedded?.contacts ?? [];
    console.log(`\n--- Lead ${lead.id} (${(lead.name || '').slice(0, 40)}) ---`);
    console.log(`  contacts: ${contacts.length}`);
    for (const c of contacts) {
      const notes: any = await kommoFetchPath(`/contacts/${c.id}/notes?limit=250&filter[note_type][]=call_in&filter[note_type][]=call_out`);
      const arr = notes?._embedded?.notes ?? [];
      console.log(`    contact ${c.id}: ${arr.length} call notes`);
      for (const n of arr) {
        const d = n.params?.duration || 0;
        const link = n.params?.link ? "🔗" : "  ";
        console.log(`      ${new Date(n.created_at * 1000).toISOString().slice(0,16)}  ${String(d).padStart(5)}s  ${link}  ${n.note_type}`);
      }
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
