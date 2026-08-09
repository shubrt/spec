import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { env } from "../../_/env";
import { schema } from "./schema";

// Concurrent requests need separate connections while the change-set pipeline
// keeps a transaction and its project-row lock open.
const pool = new Pool({ connectionString: env.DATABASE_URL });

export const db = drizzle(pool, { schema, casing: "snake_case" });

export type Db = typeof db;
