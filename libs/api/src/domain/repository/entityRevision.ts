import { and, asc, eq } from "drizzle-orm";
import { db } from "../../integration/drizzle/client";
import { entityRevision } from "../../integration/drizzle/schema/entityRevision";
import type { WorkspaceScope } from "../auth/workspaceScope";
import type { DbExecutor } from "./entity";

/**
 * Reading the append-only revision log.
 *
 * Writing it lives in `repository/entity.ts` (`recordRevision`), next to the
 * writes it records, because a revision row and the change it describes must be
 * inserted in one transaction. This file is the other direction and has no writer:
 * `entity_revision` is protected by a BEFORE UPDATE OR DELETE trigger, so there is
 * no update or delete path to offer.
 */

export type EntityRevisionRow = typeof entityRevision.$inferSelect;

/**
 * Every revision of one project, oldest first within each entity.
 *
 * The ordering is what makes the caller's diff cheap: `(entity_type, entity_id,
 * revision)` groups each entity's history together and ascending, so revision
 * N-1 is the row immediately before revision N and no per-entity sort is needed.
 * It is also the table's primary key, so the index serves the sort.
 *
 * Documents are included. They are the point — the diff needs both snapshots —
 * and the caller projects them down before anything reaches a client.
 */
async function listByProject(
  scope: WorkspaceScope,
  projectId: string,
  executor: DbExecutor = db,
): Promise<readonly EntityRevisionRow[]> {
  return await executor
    .select()
    .from(entityRevision)
    .where(and(eq(entityRevision.workspaceId, scope), eq(entityRevision.projectId, projectId)))
    .orderBy(
      asc(entityRevision.entityType),
      asc(entityRevision.entityId),
      asc(entityRevision.revision),
    );
}

export const entityRevisionRepository = { listByProject };
