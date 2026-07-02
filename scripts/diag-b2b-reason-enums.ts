// Один запрос к Kommo: enum'ы поля 876383 («Причина закрытия» b2b) —
// нужны id для «дублей» из списка Рузанны. READ-ONLY, 1 запрос.
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });
import dns from "node:dns";
dns.setDefaultResultOrder("ipv4first");
import { getLeadCustomFieldEnums } from "../src/lib/kommo/client";

async function main() {
  const enums = await getLeadCustomFieldEnums(876383);
  console.log(`Поле 876383, enum'ов: ${enums.length}`);
  for (const e of enums) console.log(" ", JSON.stringify(e));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
