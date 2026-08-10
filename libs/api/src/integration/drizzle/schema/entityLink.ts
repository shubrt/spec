import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { LinkableEntityType, RelationshipType } from "../../../domain/enums";
import { project } from "./project";
import { workspace } from "./workspace";

/**
 * The relationship graph between epics, streams and tasks — the "flexible
 * relations" table from the domain spec §9, kept out of the documents so that
 * cycle detection and dependency reads are one query rather than a jsonb walk.
 *
 * Endpoints are polymorphic `(type, id)` pairs, so they carry no foreign key:
 * a single FK column cannot point at three tables. The consequence is explicit
 * — deleting an epic cascades its streams and tasks but leaves their links
 * behind — and it is the change-set engine's job to delete the links it owns.
 * `workspace_id` and `project_id` *do* have FKs, so dropping a whole workspace
 * or project still cleans up.
 *
 * Relationships are stored in exactly one direction (`domain/enums.ts` explains
 * why `blocks` is not a value): input naming the inverse is normalised by
 * swapping source and target before it reaches this table.
 */
export const entityLink = pgTable(
  "entity_link",
  {
    id: uuid().defaultRandom().primaryKey(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    projectId: uuid()
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    sourceType: text().$type<LinkableEntityType>().notNull(),
    sourceId: uuid().notNull(),
    targetType: text().$type<LinkableEntityType>().notNull(),
    targetId: uuid().notNull(),
    relationshipType: text().$type<RelationshipType>().notNull(),
    /** The domain spec §5.5 `reason` — why this dependency exists, in prose. */
    reason: text(),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    /**
     * A self-link is never meaningful and it is the degenerate cycle every
     * graph check would otherwise have to special-case, so it is rejected by
     * the database. `check()` is supported by `push`, which is why this is here
     * and not in `manual.sql` — anything living only in `manual.sql` is at risk
     * on the next push.
     *
     * Bare column names: a CHECK expression may not qualify them.
     */
    check("entity_link_no_self", sql`not (source_type = target_type and source_id = target_id)`),
    check(
      "entity_link_endpoint_type_chk",
      sql`source_type in ('epic', 'stream', 'task', 'rule') and target_type in ('epic', 'stream', 'task', 'rule')`,
    ),
    /**
     * A hard dependency never crosses planning levels. The service reports a
     * friendly validation issue first; this check is the final invariant for
     * scripts and future writers that bypass it. `cancelled` is a status concern,
     * not an endpoint kind, so it does not change this shape.
     */
    check(
      "entity_link_blocked_by_level_chk",
      sql`relationship_type <> 'blocked_by' or (source_type = target_type and source_type in ('stream', 'task'))`,
    ),
    check(
      "entity_link_rule_relation_chk",
      sql`not (source_type = 'rule' or target_type = 'rule' or relationship_type in ('derived_from', 'exception_to')) or (source_type = 'rule' and target_type = 'rule' and relationship_type in ('related_to', 'supersedes', 'derived_from', 'exception_to'))`,
    ),
    /**
     * One link per direction per relationship. Unlinking is a real DELETE, not
     * a tombstone, so re-linking the same pair afterwards succeeds — a
     * soft-deleted row here would make the second link collide with a
     * relationship the user cannot see.
     */
    uniqueIndex("entity_link_uniq").on(
      t.sourceType,
      t.sourceId,
      t.targetType,
      t.targetId,
      t.relationshipType,
    ),
    // Both directions are read: "what blocks this" and "what does this block".
    index("entity_link_source_idx").on(t.workspaceId, t.sourceType, t.sourceId),
    index("entity_link_target_idx").on(t.workspaceId, t.targetType, t.targetId),
  ],
);
