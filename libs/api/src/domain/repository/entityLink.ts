import { and, asc, eq } from "drizzle-orm";
import { DomainError } from "../../_/errors";
import { db } from "../../integration/drizzle/client";
import { entityLink } from "../../integration/drizzle/schema/entityLink";
import type { WorkspaceScope } from "../auth/workspaceScope";
import type { EntityType, RelationshipType } from "../enums";
import type { DependencyEdge } from "../graph/cycle";
import type { DbExecutor } from "./entity";

/**
 * The relationship graph between epics, streams and tasks (domain spec §5.5, §9).
 *
 * ## One direction only
 *
 * `entity_link` stores `blocked_by` and never `blocks`. `blocks` is its exact
 * inverse, so storing both would mean every read and every cycle check has to
 * reconcile two rows that can disagree, and one of them can be deleted without the
 * other. `blocks` is still accepted as *input*, because "A blocks B" is how the
 * domain spec §7 task document says it — `link` and `unlink` normalise it by
 * swapping source and target, which is the whole of the conversion and happens in
 * one place, at the last gate before the table.
 *
 * ## Unlink is a real delete
 *
 * No tombstone, no `deleted_at`. A soft delete would leave the unique index
 * holding a row the user cannot see, so re-linking the same pair would collide with
 * a relationship that does not exist as far as anyone can tell.
 * `test/db/entityLinkRepository.db.test.ts` links, unlinks and links again.
 */

export type EntityLink = typeof entityLink.$inferSelect;

/** One end of a relationship. Polymorphic, so the type travels with the id. */
export type LinkEndpoint = {
  readonly type: EntityType;
  readonly id: string;
};

/**
 * What a caller may name. `blocks` is accepted and never stored; everything else
 * is stored as given. Mirrors `changeSet/schema.ts`'s `LINK_INPUT_RELATIONSHIP`,
 * which is what an agent sees.
 */
export type LinkRelationshipInput = RelationshipType | "blocks";

export type LinkInput = {
  readonly projectId: string;
  readonly source: LinkEndpoint;
  readonly target: LinkEndpoint;
  readonly relationship: LinkRelationshipInput;
  /** Why this dependency exists, in prose (domain spec §5.5). */
  readonly reason?: string | null;
};

export type UnlinkInput = Omit<LinkInput, "reason">;

/**
 * A `blocked_by` edge of one project, in the shape `graph/cycle.ts` consumes
 * directly — no second transformation between the query and the check.
 *
 * The two entity types ride along. The cycle check does not need them, but whoever
 * reports the cycle does: an error message that names three uuids is useless, and
 * without the types the reporter would have to query all three tables to find out
 * what it is looking at.
 */
export type ProjectDependencyEdge = DependencyEdge & {
  /** The blocked entity's type. */
  readonly fromType: EntityType;
  /** The blocker's type. */
  readonly toType: EntityType;
};

/** The direction the table stores. Everything else is normalised into it. */
const STORED_INVERSE: RelationshipType = "blocked_by";

type NormalizedLink = {
  readonly sourceType: EntityType;
  readonly sourceId: string;
  readonly targetType: EntityType;
  readonly targetId: string;
  readonly relationshipType: RelationshipType;
};

/**
 * `A blocks B` becomes `B blocked_by A`. Every other relationship passes through
 * unchanged.
 */
function normalize(input: UnlinkInput): NormalizedLink {
  const swap = input.relationship === "blocks";
  const source = swap ? input.target : input.source;
  const target = swap ? input.source : input.target;
  return {
    sourceType: source.type,
    sourceId: source.id,
    targetType: target.type,
    targetId: target.id,
    relationshipType: swap ? STORED_INVERSE : input.relationship,
  };
}

/**
 * Creates the relationship, or returns the one that is already there.
 *
 * Idempotent on purpose: an agent that re-declares a dependency it already
 * declared has not made a mistake worth failing an atomic change set for, and the
 * unique index means "already there" is the only other outcome. A `reason` sent
 * with a repeat is *not* overwritten — the first statement of why a dependency
 * exists is the one someone wrote deliberately, and silently replacing it would
 * make a re-run of the same change set destructive.
 *
 * A self-link is rejected by the database (`check("entity_link_no_self")`), which is
 * also the degenerate cycle `findDependencyCycle` reports as `[a, a]`.
 */
async function link(
  scope: WorkspaceScope,
  input: LinkInput,
  executor: DbExecutor = db,
): Promise<EntityLink> {
  const normalized = normalize(input);
  const [inserted] = await executor
    .insert(entityLink)
    .values({
      workspaceId: scope,
      projectId: input.projectId,
      ...normalized,
      reason: input.reason ?? null,
    })
    .onConflictDoNothing({
      target: [
        entityLink.sourceType,
        entityLink.sourceId,
        entityLink.targetType,
        entityLink.targetId,
        entityLink.relationshipType,
      ],
    })
    .returning();
  if (inserted) {
    return inserted;
  }
  const existing = await find(scope, normalized, executor);
  if (!existing) {
    // The insert was a no-op and the row is not visible in this scope: the pair
    // exists in another workspace. Loud rather than silent — the endpoints are
    // polymorphic, so no foreign key would have caught it either.
    throw new DomainError(
      "link_conflicts_across_scope",
      `A ${normalized.relationshipType} link between those entities exists outside this workspace.`,
    );
  }
  return existing;
}

/**
 * Deletes the relationship. `true` when a row went away, `false` when there was
 * nothing to delete — including when the link belongs to another tenant, which is
 * the same answer for the same reason as everywhere else in this layer.
 */
async function unlink(
  scope: WorkspaceScope,
  input: UnlinkInput,
  executor: DbExecutor = db,
): Promise<boolean> {
  const normalized = normalize(input);
  const deleted = await executor
    .delete(entityLink)
    .where(and(eq(entityLink.workspaceId, scope), matches(normalized)))
    .returning({ id: entityLink.id });
  return deleted.length > 0;
}

/**
 * Every `blocked_by` edge of one project.
 *
 * Only `blocked_by`: it is the one relationship that claims an order, so it is the
 * only one a loop of makes unsatisfiable. Filtering here rather than in the cycle
 * check means a caller cannot widen it by accident.
 *
 * Ordered by creation so the same graph always produces the same reported cycle;
 * `id` breaks the tie, since two links created in the same transaction share a
 * timestamp.
 */
async function edgesForProject(
  scope: WorkspaceScope,
  projectId: string,
  executor: DbExecutor = db,
): Promise<readonly ProjectDependencyEdge[]> {
  const rows = await executor
    .select({
      from: entityLink.sourceId,
      fromType: entityLink.sourceType,
      to: entityLink.targetId,
      toType: entityLink.targetType,
    })
    .from(entityLink)
    .where(
      and(
        eq(entityLink.workspaceId, scope),
        eq(entityLink.projectId, projectId),
        eq(entityLink.relationshipType, STORED_INVERSE),
      ),
    )
    .orderBy(asc(entityLink.createdAt), asc(entityLink.id));
  return rows;
}

async function find(
  scope: WorkspaceScope,
  normalized: NormalizedLink,
  executor: DbExecutor,
): Promise<EntityLink | null> {
  const [row] = await executor
    .select()
    .from(entityLink)
    .where(and(eq(entityLink.workspaceId, scope), matches(normalized)))
    .limit(1);
  return row ?? null;
}

const matches = (normalized: NormalizedLink) =>
  and(
    eq(entityLink.sourceType, normalized.sourceType),
    eq(entityLink.sourceId, normalized.sourceId),
    eq(entityLink.targetType, normalized.targetType),
    eq(entityLink.targetId, normalized.targetId),
    eq(entityLink.relationshipType, normalized.relationshipType),
  );

export const entityLinkRepository = {
  link,
  unlink,
  edgesForProject,
};
