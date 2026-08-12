import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { EpicStatus } from "../../../domain/enums";
import { tsvector } from "../customTypes";
import { project } from "./project";
import { workspace } from "./workspace";

/**
 * A long-lived business capability (domain spec §3.1) and the top of the
 * planning hierarchy: Epic → Stream → Task.
 *
 * Hybrid storage: the relational columns are everything the server filters,
 * sorts, joins or searches on; `document` holds the validated JSON content that
 * the Zod schemas own. `title` and `summary` are denormalised out of
 * `document.content` by the write path so that listing and search never have to
 * unwrap jsonb.
 *
 * `workspace_id` is denormalised here even though it is reachable through
 * `project_id`. Two load-bearing reasons: the key is unique per project, so the
 * project id has to be on the row anyway, and putting the workspace first in
 * every index means a query that forgets the tenant filter shows up as the
 * wrong index in `EXPLAIN` rather than as a silent cross-tenant read.
 */
export const epic = pgTable(
  "epic",
  {
    id: uuid().defaultRandom().primaryKey(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    projectId: uuid()
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    /** `E-1`, from `project.epic_counter`. Unique per project, never reused. */
    key: text().notNull(),
    status: text().$type<EpicStatus>().notNull().default("active"),
    /** Monotonic; every write bumps it and snapshots the document into `entity_revision`. */
    revision: integer().notNull().default(1),
    title: text().notNull(),
    summary: text(),
    // The type parameter stays open until B9 defines the document envelope.
    document: jsonb().$type<Record<string, unknown>>().notNull(),
    /**
     * `generatedAlwaysAs` emits `GENERATED ALWAYS AS (…) STORED`, which `push`
     * supports. A generated column over the two plain text columns is
     * deliberately chosen over extracting text from `document` in a helper
     * function: a generated expression may only call IMMUTABLE functions, and a
     * jsonb-extraction helper would have to be declared IMMUTABLE by hand.
     *
     * The expression uses bare column names because a generated expression may
     * not qualify them, and `'simple'` rather than a language configuration
     * because the content is mixed German/English and `'simple'` is the only
     * config that is stable across both.
     */
    searchVector: tsvector().generatedAlwaysAs(
      sql`to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(summary, ''))`,
    ),
    webSearchText: text().generatedAlwaysAs(
      sql`key || ' ' || title || ' ' || coalesce(summary, document -> 'content' ->> 'purpose', '')`,
    ),
    fuzzyChars: text()
      .array()
      .generatedAlwaysAs(sql`string_to_array(lower(title), null)`),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("epic_project_key_uniq").on(t.projectId, t.key),
    index("epic_scope_status_idx").on(t.workspaceId, t.projectId, t.status),
    index("epic_search_idx").using("gin", t.searchVector),
    index("epic_web_search_idx").using("gin", t.webSearchText.asc().op("gin_trgm_ops")),
    index("epic_fuzzy_idx").using("gin", t.fuzzyChars),
  ],
);
