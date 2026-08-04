import type { Config } from "drizzle-kit";

if (!process.env.DATABASE_URL) {
  throw new Error("Missing DATABASE_URL");
}

const url = process.env.DATABASE_URL;

export default {
  dialect: "postgresql",
  schema: "./src/integration/drizzle/schema.ts",
  out: "./src/integration/drizzle/migrations",
  dbCredentials: { url },
  casing: "snake_case",
} satisfies Config;
