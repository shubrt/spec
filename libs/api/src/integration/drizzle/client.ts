import { drizzle } from "drizzle-orm/bun-sql";
import { env } from "../../_/env";
import { schema } from "./schema";

export const db = drizzle({
  connection: env.DATABASE_URL,
  schema,
  casing: "snake_case",
});

export type Db = typeof db;
