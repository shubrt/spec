import { customType } from "drizzle-orm/pg-core";

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
