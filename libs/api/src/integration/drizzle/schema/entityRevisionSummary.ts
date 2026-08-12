import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { VersionedEntityType } from "../../../domain/enums";
import { project } from "./project";
import { workspace } from "./workspace";

/**
 * The compact, queryable half of an immutable entity revision.
 *
 * `entity_revision.document` remains the authoritative full snapshot. This
 * projection carries the final adjacent-revision classification plus internal
 * section entry counts needed to classify the next append. An AFTER INSERT
 * trigger owns new rows and the initial backfill; see `setup/manual.sql`.
 * Keeping that work in Postgres makes the
 * projection part of the same statement and transaction as the audit row rather
 * than adding one network round trip per changed entity.
 */
export const entityRevisionSummary = pgTable(
  "entity_revision_summary",
  {
    entityType: text().$type<VersionedEntityType>().notNull(),
    entityId: uuid().notNull(),
    revision: integer().notNull(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    projectId: uuid()
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    entityKey: text().notNull(),
    title: text().notNull(),
    status: text().notNull(),
    kind: text().notNull(),
    statusChanged: boolean().notNull(),
    sectionDeltas: jsonb()
      .$type<readonly { readonly section: string; readonly from: number; readonly to: number }[]>()
      .notNull(),
    /** Dotted document section path to its number of addressable entries. */
    sectionCounts: jsonb().$type<Record<string, number>>().notNull(),
    changedBy: text().notNull(),
    changeReason: text(),
    createdAt: timestamp({ withTimezone: true }).notNull(),
  },
  (t) => [
    // No composite FK back to `entity_revision`: drizzle-kit re-creates composite
    // primary keys on push, and Postgres cannot do that while a FK depends on one.
    // The source-row insert trigger is this append-only table's only writer.
    primaryKey({ columns: [t.entityType, t.entityId, t.revision] }),
    check(
      "entity_revision_summary_kind_chk",
      sql`${t.kind} in ('created', 'status', 'structure', 'text')`,
    ),
    index("entity_revision_summary_project_history_idx").on(
      t.workspaceId,
      t.projectId,
      t.createdAt.desc(),
      t.revision.desc(),
      t.entityKey.asc(),
    ),
  ],
);
