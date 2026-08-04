import { sql } from "drizzle-orm";
import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { TaskStatus, TaskType } from "../../../domain/enums";
import { jsonbObject, tsvector } from "../customTypes";
import { project } from "./project";
import { stream } from "./stream";
import { workspace } from "./workspace";

/**
 * A concrete technical unit of work under a stream (domain spec §3.3).
 *
 * Tasks are their own rows, never a nested array inside the stream document
 * (domain spec §9): they are queried, filtered and picked up independently by
 * `get_next_work`, and a nested array would make every task write a rewrite of
 * the whole stream document under OCC.
 */
export const task = pgTable(
  "task",
  {
    id: uuid().defaultRandom().primaryKey(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    projectId: uuid()
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    streamId: uuid()
      .notNull()
      .references(() => stream.id, { onDelete: "cascade" }),
    /** `TASK-45`, from `project.task_counter`. Unique per project, never reused. */
    key: text().notNull(),
    taskType: text().$type<TaskType>().notNull(),
    status: text().$type<TaskStatus>().notNull().default("draft"),
    revision: integer().notNull().default(1),
    title: text().notNull(),
    summary: text(),
    document: jsonbObject<Record<string, unknown>>()().notNull(),
    /** See `schema/epic.ts` for why this is a generated column over plain text. */
    searchVector: tsvector().generatedAlwaysAs(
      sql`to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(summary, ''))`,
    ),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("task_project_key_uniq").on(t.projectId, t.key),
    // `get_next_work` filters by workspace, project and status, so this is the
    // index it must use; the workspace-leading order is what makes a missing
    // tenant filter visible in EXPLAIN.
    index("task_scope_status_idx").on(t.workspaceId, t.projectId, t.status),
    index("task_stream_idx").on(t.workspaceId, t.streamId),
    index("task_search_idx").using("gin", t.searchVector),
  ],
);
