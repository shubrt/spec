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
import type { MilestoneStatus } from "../../../domain/enums";
import { tsvector } from "../customTypes";
import { project } from "./project";
import { workspace } from "./workspace";

/**
 * A project-level roadmap overlay, parallel to the Epic hierarchy.
 *
 * `roadmap_order` is relationally canonical because it is sorted and changed by
 * scheduling operations. It is not a dependency: equal order values are legal,
 * and later Milestones remain technically available unless explicitly filtered.
 */
export const milestone = pgTable(
  "milestone",
  {
    id: uuid().defaultRandom().primaryKey(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    projectId: uuid()
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    /** `M-2`, from `project.milestone_counter`. Unique per project, never reused. */
    key: text().notNull(),
    status: text().$type<MilestoneStatus>().notNull().default("draft"),
    revision: integer().notNull().default(1),
    title: text().notNull(),
    summary: text(),
    document: jsonb().$type<Record<string, unknown>>().notNull(),
    roadmapOrder: integer().notNull(),
    searchVector: tsvector().generatedAlwaysAs(
      sql`to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(summary, ''))`,
    ),
    webSearchText: text().generatedAlwaysAs(
      sql`key || ' ' || title || ' ' || coalesce(nullif(document -> 'content' ->> 'goal', ''), summary, '')`,
    ),
    fuzzyChars: text()
      .array()
      .generatedAlwaysAs(sql`string_to_array(lower(title), null)`),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("milestone_project_key_uniq").on(t.projectId, t.key),
    index("milestone_scope_status_idx").on(t.workspaceId, t.projectId, t.status),
    index("milestone_scope_order_idx").on(t.workspaceId, t.projectId, t.roadmapOrder),
    index("milestone_search_idx").using("gin", t.searchVector),
    index("milestone_web_search_idx").using("gin", t.webSearchText.asc().op("gin_trgm_ops")),
    index("milestone_fuzzy_idx").using("gin", t.fuzzyChars),
  ],
);
