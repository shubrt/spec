import type { SQL } from "drizzle-orm";
import type { Db } from "./client";

/**
 * Executes hand-written SQL and unwraps the row array returned by node-postgres.
 *
 * Raw Drizzle SQL cannot infer its projection, so callers supply the row shape.
 * Keeping the result-envelope handling here gives repositories one shared path
 * that cannot accidentally treat pg's QueryResult as the rows themselves.
 */
export const executeRows = async <TRow extends Record<string, unknown>>(
  executor: Pick<Db, "execute">,
  statement: SQL,
) => (await executor.execute<TRow>(statement)).rows;
