/**
 * One-time Telegram MTProto authorization script.
 * Run: node scripts/telegram-auth.mjs
 *
 * It will ask for your phone number and a code from Telegram.
 * After auth, it prints a SESSION string — save it to .env.local as TELEGRAM_SESSION.
 */

import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import readline from "readline";

const API_ID = 37992601;
const API_HASH = "49e00c7f713bbc76f40dc71595227c34";

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((res) => rl.question(q, res));

const session = new StringSession("");
const client = new TelegramClient(session, API_ID, API_HASH, {
  connectionRetries: 5,
});

await client.start({
  phoneNumber: () => ask("Введите номер телефона (формат +7...): "),
  password: () => ask("Введите 2FA пароль (если есть, иначе Enter): "),
  phoneCode: () => ask("Введите код из Telegram: "),
  onError: (err) => console.error("Ошибка:", err),
});

console.log("\n✅ Авторизация успешна!\n");
console.log("Добавьте в .env.local:\n");
console.log(`TELEGRAM_SESSION=${client.session.save()}`);
console.log(`TELEGRAM_API_ID=37992601`);
console.log(`TELEGRAM_API_HASH=49e00c7f713bbc76f40dc71595227c34`);

rl.close();
await client.disconnect();
process.exit(0);
