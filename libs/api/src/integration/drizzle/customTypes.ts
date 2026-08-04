import { customType } from "drizzle-orm/pg-core";

/**
 * drizzle-orm's built-in `jsonb()` always `JSON.stringify`s on the way in
 * (`mapToDriverValue`), which is correct for drivers like node-postgres that
 * never touch the JS value themselves. `drizzle-orm/bun-sql`'s driver calls
 * Bun's own `client.unsafe(query, params)`, which *also* serialises a plain
 * object bound to a jsonb-typed placeholder — stacking the two double-encodes
 * the payload into a jsonb string scalar, so `document->>'key'` silently
 * returns null instead of the value. Passing the object straight through
 * (`toDriver` omitted) and only parsing on the way out fixes it for this
 * driver without changing the column's SQL type or its TS shape.
 *
 * It lives here rather than in one schema file because the failure mode is
 * silent: a jsonb column declared with the plain builder looks identical and
 * only misbehaves at read time.
 */
export const jsonbObject = <T>() =>
  customType<{ data: T; driverData: T | string }>({
    dataType: () => "jsonb",
    fromDriver: (value) => (typeof value === "string" ? (JSON.parse(value) as T) : value),
  });

/**
 * `tsvector` has no builder in drizzle-orm 0.45.2, and the search columns are
 * `GENERATED ALWAYS AS … STORED`, so nothing ever binds a value to them from
 * the application side — this type exists purely so `push` emits the right
 * column type and so the GIN index can reference the column.
 *
 * Reading it back yields Postgres' text rendering of the lexeme vector, which
 * is only ever useful for debugging; queries match with `@@`, never by
 * comparing this string.
 */
export const tsvector = customType<{ data: string; driverData: string }>({
  dataType: () => "tsvector",
});
