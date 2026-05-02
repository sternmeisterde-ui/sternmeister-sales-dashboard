/**
 * generate-mcp-tokens.ts — генерация bearer-tokens для MCP server.
 *
 * Использование:
 *   npx tsx scripts/generate-mcp-tokens.ts
 *
 * Output: JSON-массив для MCP_BEARER_TOKENS env, ready to paste в Dokploy.
 *
 * Текущие пользователи (отредактируй массив USERS если нужно):
 *   - antares — admin (все depts)
 *   - dima    — rop (b2g — Госники)
 *   - ruzanna — rop (b2b — Коммерсы)
 *
 * Tokens — `sk-mcp-` + 48 hex chars (24 bytes random). Print только raw JSON,
 * никаких stdout-дополнений (легче скопировать в Dokploy).
 */

import { randomBytes } from "node:crypto";

interface UserSpec {
  userId: string;
  name: string;
  role: "admin" | "rop" | "manager";
  depts: ReadonlyArray<"b2g" | "b2b" | "*">;
}

const USERS: ReadonlyArray<UserSpec> = [
  { userId: "antares", name: "Антон", role: "admin", depts: ["*"] },
  { userId: "dima", name: "Дмитрий", role: "rop", depts: ["b2g"] },
  { userId: "ruzanna", name: "Рузанна", role: "rop", depts: ["b2b"] },
];

const today = new Date().toISOString().slice(0, 10);

const tokens = USERS.map((u) => ({
  token: `sk-mcp-${randomBytes(24).toString("hex")}`,
  userId: u.userId,
  name: u.name,
  role: u.role,
  depts: u.depts,
  issued: today,
}));

// ⚠️  Each invocation MINTS NEW TOKENS for ALL users — there is no
//     per-user mode. Running this twice silently invalidates every token
//     issued by the previous run. To rotate one user only, edit the env
//     value in Dokploy by hand.
process.stderr.write(
  "\n⚠️  WARNING: this generates ALL tokens fresh. Replacing MCP_BEARER_TOKENS in Dokploy with this output INVALIDATES all previously-issued tokens. Re-distribute via Discord DM.\n",
);

// Print to stdout only — каждый ряд отдельной строкой для читаемости в копировании.
process.stdout.write(JSON.stringify(tokens, null, 2));
process.stdout.write("\n");

// Per-user one-liner для отправки через Discord DM (на stderr — не попадает в paste).
process.stderr.write("\n=== Distribution snippets (Discord DM) ===\n");
for (const t of tokens) {
  process.stderr.write(
    `\n[${t.name} / ${t.userId}]\nClaude Desktop config:\n` +
      `{\n  "mcpServers": {\n    "sternmeister": {\n      "url": "https://mcp.sternmeister.de/mcp",\n      "headers": {\n        "Authorization": "Bearer ${t.token}"\n      }\n    }\n  }\n}\n`,
  );
}
process.stderr.write("\n=== End ===\n");
