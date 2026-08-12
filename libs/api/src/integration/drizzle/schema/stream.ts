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
import type { StreamStatus, StreamType } from "../../../domain/enums";
import { tsvector } from "../customTypes";
import { epic } from "./epic";
import { milestone } from "./milestone";
import { project } from "./project";
import { workspace } from "./workspace";

/**
 * A bounded change, problem or investigation inside an epic (domain spec §3.2)
 * and the central planning unit for the business "what".
 *
 * The FK is single-column on the immediate parent, `epic_id → epic.id`. A
 * three-column composite FK carrying the tenant chain was considered and
 * rejected: `workspace_id` and `project_id` are denormalised here for indexing
 * and search, and the invariant that a `move` cannot orphan a subtree is
 * enforced atomically by the change-set engine, not by a constraint.
 *
 * `stream_type` accepts all seven types from the domain spec even though only
 * three of them get a dedicated content schema in the MVP.
 */
export const stream = pgTable(
  "stream",
  {
    id: uuid().defaultRandom().primaryKey(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    projectId: uuid()
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    epicId: uuid()
      .notNull()
      .references(() => epic.id, { onDelete: "cascade" }),
    /** Optional roadmap placement; Milestone deletion returns the Stream to the backlog. */
    milestoneId: uuid().references(() => milestone.id, { onDelete: "set null" }),
    /** Advisory ordering inside one Milestone. Equal ranks deliberately mean parallel work. */
    roadmapRank: integer(),
    /** `S-12`, from `project.stream_counter`. Unique per project, never reused. */
    key: text().notNull(),
    streamType: text().$type<StreamType>().notNull(),
    status: text().$type<StreamStatus>().notNull().default("draft"),
    revision: integer().notNull().default(1),
    title: text().notNull(),
    summary: text(),
    document: jsonb().$type<Record<string, unknown>>().notNull(),
    /** See `schema/epic.ts` for why this is a generated column over plain text. */
    searchVector: tsvector().generatedAlwaysAs(
      sql`to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(summary, ''))`,
    ),
    webSearchText: text().generatedAlwaysAs(
      sql`key || ' ' || title || ' ' || coalesce(nullif(document -> 'content' ->> 'purpose', ''), summary, '')`,
    ),
    fuzzyChars: text()
      .array()
      .generatedAlwaysAs(sql`string_to_array(lower(title), null)`),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("stream_project_key_uniq").on(t.projectId, t.key),
    index("stream_scope_status_idx").on(t.workspaceId, t.projectId, t.status),
    index("stream_epic_idx").on(t.workspaceId, t.epicId),
    index("stream_milestone_rank_idx").on(t.workspaceId, t.projectId, t.milestoneId, t.roadmapRank),
    index("stream_search_idx").using("gin", t.searchVector),
    index("stream_web_search_idx").using("gin", t.webSearchText.asc().op("gin_trgm_ops")),
    index("stream_fuzzy_idx").using("gin", t.fuzzyChars),
  ],
);
