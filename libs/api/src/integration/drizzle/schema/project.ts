import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { workspace } from "./workspace";

/**
 * A project is a technical container inside a workspace (domain spec §3), not a
 * planning object: it has no `document`, no `revision` and no status, because
 * nothing about it is versioned or validated. The three counter columns are the
 * reason it is a table of its own rather than a column on `workspace`.
 *
 * `epic_counter` / `stream_counter` / `task_counter` are the key sequences
 * behind `EPIC-1`, `STR-12`, `TASK-45`. They live on this row, not in a
 * Postgres sequence, so the change-set transaction can take `SELECT … FOR
 * UPDATE` on the project row and hand out keys race-free without retry logic —
 * and so a rolled-back change-set does not burn a key the way a sequence would.
 * Each column holds the last key issued; B11 owns the increment.
 */
export const project = pgTable(
  "project",
  {
    id: uuid().defaultRandom().primaryKey(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    name: text().notNull(),
    epicCounter: integer().notNull().default(0),
    streamCounter: integer().notNull().default(0),
    taskCounter: integer().notNull().default(0),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // The name is how an agent addresses a project in natural language
    // ("add an epic to zpecs"), so it has to resolve to exactly one row.
    uniqueIndex("project_workspace_name_uniq").on(t.workspaceId, t.name),
    index("project_workspace_idx").on(t.workspaceId),
  ],
);
