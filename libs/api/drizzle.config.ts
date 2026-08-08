/// <reference types="node" />

import type { Config } from "drizzle-kit";

const url = process.env.ZPECS_DATABASE_URL || process.env.DATABASE_URL;

if (!url) {
  throw new Error("Missing ZPECS_DATABASE_URL or DATABASE_URL");
}

export default {
  dialect: "postgresql",
  schema: "./src/integration/drizzle/schema.ts",
  out: "./src/integration/drizzle/migrations",
  dbCredentials: { url },
  casing: "snake_case",
} satisfies Config;
