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
import type { RuleStatus } from "../../../domain/enums";
import { tsvector } from "../customTypes";
import { project } from "./project";
import { workspace } from "./workspace";

/**
 * A canonical project Rule: defined once, independently revisioned and reused by
 * local applications in Epic and Stream documents.
 *
 * Rule references intentionally have no FK here because those references live in
 * validated JSON documents. The domain service will guard deprecation and delete
 * against consumers; this table owns only the Rule aggregate itself.
 */
export const rule = pgTable(
  "rule",
  {
    id: uuid().defaultRandom().primaryKey(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    projectId: uuid()
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    /** `R-7`, from `project.rule_counter`. Unique per project, never reused. */
    key: text().notNull(),
    status: text().$type<RuleStatus>().notNull().default("draft"),
    revision: integer().notNull().default(1),
    title: text().notNull(),
    summary: text(),
    document: jsonb().$type<Record<string, unknown>>().notNull(),
    searchVector: tsvector().generatedAlwaysAs(
      sql`to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(summary, ''))`,
    ),
    webSearchText: text().generatedAlwaysAs(
      sql`key || ' ' || title || ' ' || coalesce(nullif(document -> 'content' ->> 'statement', ''), summary, '')`,
    ),
    fuzzyChars: text()
      .array()
      .generatedAlwaysAs(sql`string_to_array(lower(title), null)`),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("rule_project_key_uniq").on(t.projectId, t.key),
    index("rule_scope_status_idx").on(t.workspaceId, t.projectId, t.status),
    index("rule_search_idx").using("gin", t.searchVector),
    index("rule_web_search_idx").using("gin", t.webSearchText.asc().op("gin_trgm_ops")),
    index("rule_fuzzy_idx").using("gin", t.fuzzyChars),
  ],
);
