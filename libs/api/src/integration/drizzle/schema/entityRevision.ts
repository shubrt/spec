import { index, integer, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { EntityType } from "../../../domain/enums";
import { jsonbObject } from "../customTypes";
import { project } from "./project";
import { workspace } from "./workspace";

/**
 * A full document snapshot per revision — and the system's only audit trail.
 * There is deliberately no separate `audit_log` table: an append-only history of
 * the documents themselves, with who changed them and why, is strictly more
 * information than a log of change events, and one table cannot drift from the
 * other.
 *
 * Full snapshots rather than diffs: reading revision N must not require
 * replaying N-1 patches, and a change-set already computes the whole next
 * document anyway.
 *
 * The primary key is `(entity_type, entity_id, revision)`, which is also the
 * lookup — "revision 3 of this stream" — so no surrogate id is needed. It is
 * what makes a duplicate revision number a constraint violation instead of two
 * conflicting histories.
 *
 * Immutability is enforced by a BEFORE UPDATE OR DELETE trigger, which is the
 * one thing in this schema Drizzle cannot express; it lives in `setup/manual.sql`
 * in the "after the first push" half. A later `push` never drops it, because
 * push diffs tables, columns, indexes and constraints — and a trigger is none
 * of those.
 *
 * Verified consequence of that trigger: once a workspace has revisions,
 * `DELETE FROM workspace` fails. The cascade below reaches `entity_revision` as
 * a row-level DELETE and the trigger rejects it, so the whole statement rolls
 * back. That is the correct default — a hard delete must not be able to erase
 * the audit trail as a side effect — and it costs nothing today because the MVP
 * exposes no delete path for a workspace or a project. Wiping a tenant on
 * purpose is `TRUNCATE` (not a row DELETE, so the trigger does not fire), which
 * is what the DB test harness uses.
 */
export const entityRevision = pgTable(
  "entity_revision",
  {
    entityType: text().$type<EntityType>().notNull(),
    entityId: uuid().notNull(),
    revision: integer().notNull(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    projectId: uuid()
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    document: jsonbObject<Record<string, unknown>>()().notNull(),
    /** Clerk user id of the human, or the agent identity acting on their behalf. */
    changedBy: text().notNull(),
    /** Why, in the author's words. Nullable: the first revision has no prior state to explain. */
    changeReason: text(),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.entityType, t.entityId, t.revision] }),
    // Workspace-leading, like every other index here, so a history read that
    // forgets the tenant filter shows up in EXPLAIN.
    index("entity_revision_scope_idx").on(t.workspaceId, t.entityType, t.entityId),
  ],
);
