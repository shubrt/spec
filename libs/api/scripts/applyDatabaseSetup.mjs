import { readFile } from "node:fs/promises";
import pg from "pg";

const { Client } = pg;
const [phase] = process.argv.slice(2);

if (phase !== "before" && phase !== "after") {
  throw new Error("Usage: node applyDatabaseSetup.mjs <before|after>");
}

const connectionString = process.env.ZPECS_DATABASE_URL || process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("Missing ZPECS_DATABASE_URL or DATABASE_URL");
}

const sql =
  phase === "before"
    ? "CREATE EXTENSION IF NOT EXISTS pg_trgm;"
    : await readFile(
        new URL("../src/integration/drizzle/setup/manual.sql", import.meta.url),
        "utf8",
      );

const client = new Client({ connectionString });

try {
  await client.connect();
  await client.query("BEGIN");
  await client.query(sql);
  await client.query("COMMIT");
  process.stdout.write(`Applied ${phase}-push Zpecs database setup.\n`);
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  await client.end().catch(() => undefined);
}
