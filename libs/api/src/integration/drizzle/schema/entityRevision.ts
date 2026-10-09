import {
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { VersionedEntityType } from "../../../domain/enums";
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
 * the audit trail as a side effect. Wiping a tenant on purpose is `TRUNCATE`
 * (not a row DELETE, so the trigger does not fire), which must remain an
 * explicit operator action.
 *
 * Deleting a Project is the single deliberate exception: its transaction names
 * the workspace in `spec.deleting_project_in_workspace`, and the trigger then
 * admits deletes of that workspace's revisions whose Project no longer exists.
 * See `workspaceRepository.deleteProject`.
 *
 * `project_id` is where the revision was written, and it deliberately has no
 * foreign key. A cross-project move re-revisions only the moved root, so the
 * descendants' snapshots, including the ones Tasks pin, keep the old project's
 * id. A cascade from `project` would take that live history with it. Instead a
 * revision is deleted once both its Project and its entity are gone, so a moved
 * entity's older revisions outlive the Project they were written in, and go when
 * the entity does.
 *
 * Dropping the former foreign key is one-way: before deploying a version that
 * still declares it, re-add it as `NOT VALID`, or that version's push fails on
 * the rows above.
 */
export const entityRevision = pgTable(
  "entity_revision",
  {
    entityType: text().$type<VersionedEntityType>().notNull(),
    entityId: uuid().notNull(),
    revision: integer().notNull(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    /** No foreign key on purpose, see above. */
    projectId: uuid().notNull(),
    document: jsonb().$type<Record<string, unknown>>().notNull(),
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
