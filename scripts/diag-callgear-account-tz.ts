// Железная проверка таймзоны аккаунта CallGear: get.account возвращает
// настройки аккаунта, включая timezone. READ-ONLY, один запрос.

import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

async function main() {
  const res = await fetch("https://dataapi.callgear.com/v2.0", {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=UTF-8" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "get.account",
      params: { access_token: process.env.CALLGEAR_ACCESS_TOKEN },
    }),
  });
  const json = await res.json();
  console.log(JSON.stringify(json, null, 2));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
