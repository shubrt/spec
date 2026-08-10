import { and, asc, eq, sql } from "drizzle-orm";
import { DomainError } from "../../_/errors";
import { db } from "../../integration/drizzle/client";
import { epic } from "../../integration/drizzle/schema/epic";
import { milestone } from "../../integration/drizzle/schema/milestone";
import { stream } from "../../integration/drizzle/schema/stream";
import type { WorkspaceScope } from "../auth/workspaceScope";
import { MILESTONE_STATUS, type MilestoneStatus } from "../enums";
import {
  type DbExecutor,
  type DbTransaction,
  FIRST_REVISION,
  type RevisionAuthor,
  type WriteResult,
  issueKey,
  recordRevision,
  stampServerOwnedMeta,
} from "./entity";

/** A revisioned roadmap overlay that remains independent of hard dependencies. */
export type Milestone = typeof milestone.$inferSelect;

export type MilestoneStream = {
  readonly key: string;
  readonly title: string;
  readonly status: string;
  readonly streamType: string;
  readonly epicKey: string;
  readonly roadmapRank: number | null;
};

export type InsertMilestoneInput = RevisionAuthor & {
  readonly projectId: string;
  readonly document: Record<string, unknown>;
  readonly summary?: string | null;
  /** Server-managed canonical placement in the project's roadmap. */
  readonly roadmapOrder: number;
};

export type UpdateMilestoneInput = RevisionAuthor & {
  readonly id: string;
  readonly expectedRevision: number;
  readonly document: Record<string, unknown>;
  /** Omitted leaves the stored summary alone; `null` clears it. */
  readonly summary?: string | null;
  /**
   * Internal scheduling input. Generic document updates omit this; the later
   * schedule/reorder service owns changes to it.
   */
  readonly roadmapOrder?: number;
};

export type CancelMilestoneInput = RevisionAuthor & {
  readonly id: string;
  readonly expectedRevision: number;
};

export type DeleteMilestoneInput = {
  readonly id: string;
  readonly expectedRevision: number;
};

const CANCELLED: MilestoneStatus = "cancelled";

async function findById(
  scope: WorkspaceScope,
  id: string,
  executor: DbExecutor = db,
): Promise<Milestone | null> {
  const [row] = await executor
    .select()
    .from(milestone)
    .where(and(eq(milestone.workspaceId, scope), eq(milestone.id, id)))
    .limit(1);
  return row ?? null;
}

async function findByKey(
  scope: WorkspaceScope,
  input: { readonly projectId: string; readonly key: string },
  executor: DbExecutor = db,
): Promise<Milestone | null> {
  const [row] = await executor
    .select()
    .from(milestone)
    .where(
      and(
        eq(milestone.workspaceId, scope),
        eq(milestone.projectId, input.projectId),
        eq(milestone.key, input.key),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Roadmap order is advisory; equal values remain adjacent and valid. */
async function listByProject(
  scope: WorkspaceScope,
  projectId: string,
  executor: DbExecutor = db,
): Promise<Milestone[]> {
  return await executor
    .select()
    .from(milestone)
    .where(and(eq(milestone.workspaceId, scope), eq(milestone.projectId, projectId)))
    .orderBy(asc(milestone.roadmapOrder), asc(milestone.createdAt), asc(milestone.key));
}

/** Compact assigned Streams, ordered once for Milestone context without loading documents. */
async function listAssignedStreams(
  scope: WorkspaceScope,
  milestoneId: string,
  executor: DbExecutor = db,
): Promise<MilestoneStream[]> {
  return await executor
    .select({
      key: stream.key,
      title: stream.title,
      status: stream.status,
      streamType: stream.streamType,
      epicKey: epic.key,
      roadmapRank: stream.roadmapRank,
    })
    .from(stream)
    .innerJoin(epic, and(eq(epic.id, stream.epicId), eq(epic.workspaceId, scope)))
    .where(and(eq(stream.workspaceId, scope), eq(stream.milestoneId, milestoneId)))
    .orderBy(sql`${stream.roadmapRank} asc nulls last`, asc(stream.createdAt), asc(stream.key));
}

async function insert(
  scope: WorkspaceScope,
  input: InsertMilestoneInput,
  tx: DbTransaction,
): Promise<WriteResult<Milestone>> {
  const key = await issueKey(scope, tx, { entity: "milestone", projectId: input.projectId });
  if (key === null) {
    return { ok: false, reason: "not_found" };
  }
  const id = crypto.randomUUID();
  const stamped = stampServerOwnedMeta(input.document, {
    id,
    key,
    revision: FIRST_REVISION,
    statuses: MILESTONE_STATUS,
    sections: withRoadmapOrder(input.roadmapOrder),
  });
  const [row] = await tx
    .insert(milestone)
    .values({
      id,
      workspaceId: scope,
      projectId: input.projectId,
      key,
      status: stamped.status,
      revision: FIRST_REVISION,
      title: stamped.title,
      summary: input.summary ?? null,
      document: stamped.document,
      roadmapOrder: input.roadmapOrder,
    })
    .returning();
  if (!row) {
    throw new DomainError("insert_returned_no_row", `Insert of milestone ${key} returned no row.`);
  }
  await recordRevision(scope, tx, {
    entityType: "milestone",
    entityId: row.id,
    projectId: row.projectId,
    revision: row.revision,
    document: row.document,
    changedBy: input.changedBy,
    changeReason: input.changeReason,
  });
  return { ok: true, row };
}

async function bumpRevision(
  scope: WorkspaceScope,
  input: UpdateMilestoneInput,
  tx: DbTransaction,
): Promise<WriteResult<Milestone>> {
  const current = await findById(scope, input.id, tx);
  if (!current) {
    return { ok: false, reason: "not_found" };
  }
  return await writeRevision(scope, tx, current, input);
}

/** Cancellation is explicit and retains the Milestone and its revision history. */
async function cancel(
  scope: WorkspaceScope,
  input: CancelMilestoneInput,
  tx: DbTransaction,
): Promise<WriteResult<Milestone>> {
  const current = await findById(scope, input.id, tx);
  if (!current) {
    return { ok: false, reason: "not_found" };
  }
  return await writeRevision(scope, tx, current, {
    ...input,
    document: current.document,
    sections: { meta: { status: CANCELLED } },
  });
}

/**
 * Low-level OCC delete. `ON DELETE SET NULL` deliberately returns assigned
 * Streams to the backlog; policy guards belong to the scheduling service.
 */
async function deleteMilestone(
  scope: WorkspaceScope,
  input: DeleteMilestoneInput,
  tx: DbTransaction,
): Promise<WriteResult<Milestone>> {
  const [row] = await tx
    .delete(milestone)
    .where(
      and(
        eq(milestone.workspaceId, scope),
        eq(milestone.id, input.id),
        eq(milestone.revision, input.expectedRevision),
      ),
    )
    .returning();
  if (!row) {
    return await conflict(scope, input.id, tx);
  }
  return { ok: true, row };
}

const withRoadmapOrder = (
  roadmapOrder: number,
  sections: Readonly<Record<string, Record<string, unknown>>> = {},
): Readonly<Record<string, Record<string, unknown>>> => ({
  ...sections,
  meta: { ...sections.meta, roadmap_order: roadmapOrder },
});

async function conflict(
  scope: WorkspaceScope,
  id: string,
  tx: DbTransaction,
): Promise<WriteResult<Milestone>> {
  const current = await findById(scope, id, tx);
  return current
    ? { ok: false, reason: "revision_conflict", current }
    : { ok: false, reason: "not_found" };
}

async function writeRevision(
  scope: WorkspaceScope,
  tx: DbTransaction,
  current: Milestone,
  input: RevisionAuthor & {
    readonly expectedRevision: number;
    readonly document: Record<string, unknown>;
    readonly summary?: string | null;
    readonly roadmapOrder?: number;
    readonly sections?: Readonly<Record<string, Record<string, unknown>>>;
  },
): Promise<WriteResult<Milestone>> {
  const revision = input.expectedRevision + 1;
  const roadmapOrder = input.roadmapOrder ?? current.roadmapOrder;
  const stamped = stampServerOwnedMeta(input.document, {
    id: current.id,
    key: current.key,
    revision,
    statuses: MILESTONE_STATUS,
    sections: withRoadmapOrder(roadmapOrder, input.sections),
  });
  const [row] = await tx
    .update(milestone)
    .set({
      status: stamped.status,
      revision,
      title: stamped.title,
      document: stamped.document,
      roadmapOrder,
      ...(input.summary === undefined ? {} : { summary: input.summary }),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(milestone.workspaceId, scope),
        eq(milestone.id, current.id),
        eq(milestone.revision, input.expectedRevision),
      ),
    )
    .returning();
  if (!row) {
    return await conflict(scope, current.id, tx);
  }
  await recordRevision(scope, tx, {
    entityType: "milestone",
    entityId: row.id,
    projectId: row.projectId,
    revision: row.revision,
    document: row.document,
    changedBy: input.changedBy,
    changeReason: input.changeReason,
  });
  return { ok: true, row };
}

export const milestoneRepository = {
  findById,
  findByKey,
  listByProject,
  listAssignedStreams,
  insert,
  bumpRevision,
  cancel,
  delete: deleteMilestone,
};
