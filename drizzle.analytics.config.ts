// Drizzle config for the analytics DB (separate Neon project).
// Default config in drizzle.config.ts still points at D1 (DATABASE_URL).
// Run via: npm run db:generate:analytics / db:migrate:analytics

import * as dotenv from "dotenv";
import { defineConfig } from "drizzle-kit";

dotenv.config({ path: ".env.local" });

const url = process.env.ANALYTICS_DATABASE_URL;
if (!url) {
  throw new Error("ANALYTICS_DATABASE_URL is not set — add it to .env.local");
}

export default defineConfig({
  schema: "./src/lib/db/schema-analytics.ts",
  out: "./drizzle/analytics",
  dialect: "postgresql",
  dbCredentials: { url },
});
