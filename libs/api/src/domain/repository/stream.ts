import { and, asc, eq, inArray } from "drizzle-orm";
import { DomainError } from "../../_/errors";
import { db } from "../../integration/drizzle/client";
import { epic } from "../../integration/drizzle/schema/epic";
import { milestone } from "../../integration/drizzle/schema/milestone";
import { stream } from "../../integration/drizzle/schema/stream";
import { task } from "../../integration/drizzle/schema/task";
import type { WorkspaceScope } from "../auth/workspaceScope";
import { STREAM_STATUS, STREAM_TYPE, type StreamType } from "../enums";
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

/**
 * The stream aggregate — the central planning unit for the business "what"
 * (domain spec §3.2). `repository/epic.ts` carries the full rationale for the
 * optimistic-concurrency clause and for why claiming is not a mechanism; this file
 * follows it exactly.
 *
 * What is specific to a stream: its parent is an epic, its terminal status is
 * `cancelled` rather than `archived`, and `stream_type` is denormalised from the
 * document because it is what selects the content schema.
 */

export type Stream = typeof stream.$inferSelect;

export type StreamRoadmapPosition = {
  readonly streamId: string;
  readonly milestoneOrder: number | null;
  readonly streamOrder: number | null;
};

export type InsertStreamInput = RevisionAuthor & {
  readonly projectId: string;
  readonly epicId: string;
  readonly document: Record<string, unknown>;
  readonly summary?: string | null;
};

export type UpdateStreamInput = RevisionAuthor & {
  readonly id: string;
  readonly expectedRevision: number;
  readonly document: Record<string, unknown>;
  /** Omitted leaves the stored summary alone; `null` clears it. */
  readonly summary?: string | null;
};

export type ArchiveStreamInput = RevisionAuthor & {
  readonly id: string;
  readonly expectedRevision: number;
};

export type DeleteStreamInput = {
  readonly id: string;
  readonly expectedRevision: number;
};

export type MoveStreamInput = RevisionAuthor & {
  readonly id: string;
  readonly expectedRevision: number;
  /** The epic the stream moves under; its project comes with it. */
  readonly epicId: string;
};

export type ScheduleStreamInput = RevisionAuthor & {
  readonly id: string;
  readonly expectedRevision: number;
  readonly milestoneId: string | null;
  readonly milestoneKey: string | null;
  readonly roadmapRank: number | null;
};

/**
 * A stream that is not being pursued is `cancelled`. There is deliberately no
 * `archived` for a stream: `domain/enums.ts` models the domain spec §8 ladder, and
 * inventing an eighth value would be a status the readiness gates, `get_next_work`
 * and the web app have never heard of.
 */
const ARCHIVED: (typeof STREAM_STATUS)[number] = "cancelled";

async function findById(
  scope: WorkspaceScope,
  id: string,
  executor: DbExecutor = db,
): Promise<Stream | null> {
  const [row] = await executor
    .select()
    .from(stream)
    .where(and(eq(stream.workspaceId, scope), eq(stream.id, id)))
    .limit(1);
  return row ?? null;
}

/** A key is unique per project, so the project is part of the lookup. */
async function findByKey(
  scope: WorkspaceScope,
  input: { readonly projectId: string; readonly key: string },
  executor: DbExecutor = db,
): Promise<Stream | null> {
  const [row] = await executor
    .select()
    .from(stream)
    .where(
      and(
        eq(stream.workspaceId, scope),
        eq(stream.projectId, input.projectId),
        eq(stream.key, input.key),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Every stream in one project, in one query — **not** one query per epic.
 *
 * The caller (`domain/service/projectAggregate.ts`) groups them by `epicId` in
 * memory. That is the whole reason `project_id` is denormalised onto the stream
 * row: the naive shape of this read is one query per epic, and a project with
 * thirty epics would pay thirty round trips to draw one board. Served by
 * `stream_scope_status_idx` (workspace-leading).
 *
 * Ordering matches `epicRepository.listByProject`; see the note there on why
 * `key` is the tiebreaker and not the sort.
 */
async function listByProject(
  scope: WorkspaceScope,
  projectId: string,
  executor: DbExecutor = db,
): Promise<Stream[]> {
  return await executor
    .select()
    .from(stream)
    .where(and(eq(stream.workspaceId, scope), eq(stream.projectId, projectId)))
    .orderBy(asc(stream.createdAt), asc(stream.key));
}

/**
 * The streams of one epic.
 *
 * `get_next_work`'s first read when it is pointed at an epic: an epic spans all of
 * its streams, so the tasks it can offer are the tasks of these. Served by
 * `stream_epic_idx`. `listByProject` is the wrong tool for it — it would read
 * every stream of the project and throw most of them away.
 */
async function listByEpic(
  scope: WorkspaceScope,
  epicId: string,
  executor: DbExecutor = db,
): Promise<Stream[]> {
  return await executor
    .select()
    .from(stream)
    .where(and(eq(stream.workspaceId, scope), eq(stream.epicId, epicId)))
    .orderBy(asc(stream.createdAt), asc(stream.key));
}

async function listByMilestone(
  scope: WorkspaceScope,
  milestoneId: string,
  executor: DbExecutor = db,
): Promise<Stream[]> {
  return await executor
    .select()
    .from(stream)
    .where(and(eq(stream.workspaceId, scope), eq(stream.milestoneId, milestoneId)))
    .orderBy(asc(stream.roadmapRank), asc(stream.createdAt), asc(stream.key));
}

/**
 * Advisory Roadmap positions for a set of Streams in one query. An unscheduled
 * Stream has no joined Milestone and therefore returns null orders; equal values
 * remain equal because Roadmap order is not a dependency.
 */
async function listRoadmapPositions(
  scope: WorkspaceScope,
  streamIds: readonly string[],
  executor: DbExecutor = db,
): Promise<StreamRoadmapPosition[]> {
  if (streamIds.length === 0) {
    return [];
  }
  return await executor
    .select({
      streamId: stream.id,
      milestoneOrder: milestone.roadmapOrder,
      streamOrder: stream.roadmapRank,
    })
    .from(stream)
    .leftJoin(
      milestone,
      and(
        eq(milestone.workspaceId, scope),
        eq(milestone.projectId, stream.projectId),
        eq(milestone.id, stream.milestoneId),
      ),
    )
    .where(and(eq(stream.workspaceId, scope), inArray(stream.id, [...streamIds])));
}

async function insert(
  scope: WorkspaceScope,
  input: InsertStreamInput,
  tx: DbTransaction,
): Promise<WriteResult<Stream>> {
  const key = await issueKey(scope, tx, { entity: "stream", projectId: input.projectId });
  if (key === null) {
    return { ok: false, reason: "not_found" };
  }
  const id = crypto.randomUUID();
  const stamped = stampServerOwnedMeta(input.document, {
    id,
    key,
    revision: FIRST_REVISION,
    statuses: STREAM_STATUS,
    sections: { links: { parent_epic_id: input.epicId } },
  });
  const [row] = await tx
    .insert(stream)
    .values({
      id,
      workspaceId: scope,
      projectId: input.projectId,
      epicId: input.epicId,
      key,
      streamType: readStreamType(stamped.document, key),
      status: stamped.status,
      revision: FIRST_REVISION,
      title: stamped.title,
      summary: input.summary ?? null,
      document: stamped.document,
    })
    .returning();
  if (!row) {
    throw new DomainError("insert_returned_no_row", `Insert of stream ${key} returned no row.`);
  }
  await recordRevision(scope, tx, {
    entityType: "stream",
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
  input: UpdateStreamInput,
  tx: DbTransaction,
): Promise<WriteResult<Stream>> {
  const current = await findById(scope, input.id, tx);
  if (!current) {
    return { ok: false, reason: "not_found" };
  }
  return await writeRevision(scope, tx, current, input);
}

async function archive(
  scope: WorkspaceScope,
  input: ArchiveStreamInput,
  tx: DbTransaction,
): Promise<WriteResult<Stream>> {
  const current = await findById(scope, input.id, tx);
  if (!current) {
    return { ok: false, reason: "not_found" };
  }
  return await writeRevision(scope, tx, current, {
    ...input,
    document: current.document,
    sections: { meta: { status: ARCHIVED } },
  });
}

/**
 * Changes only the advisory roadmap overlay, under the Stream's OCC revision.
 * The canonical M-key/rank are mirrored into stored meta so revision history can
 * reconstruct the planning judgment without turning it into a dependency.
 */
async function schedule(
  scope: WorkspaceScope,
  input: ScheduleStreamInput,
  tx: DbTransaction,
): Promise<WriteResult<Stream>> {
  const current = await findById(scope, input.id, tx);
  if (!current) return { ok: false, reason: "not_found" };
  const revision = input.expectedRevision + 1;
  const stamped = stampServerOwnedMeta(current.document, {
    id: current.id,
    key: current.key,
    revision,
    statuses: STREAM_STATUS,
    sections: {
      meta: {
        milestone_key: input.milestoneKey,
        roadmap_rank: input.roadmapRank,
      },
    },
  });
  const [row] = await tx
    .update(stream)
    .set({
      milestoneId: input.milestoneId,
      roadmapRank: input.roadmapRank,
      revision,
      title: stamped.title,
      status: stamped.status,
      streamType: readStreamType(stamped.document, current.key),
      document: stamped.document,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(stream.workspaceId, scope),
        eq(stream.id, current.id),
        eq(stream.revision, input.expectedRevision),
      ),
    )
    .returning();
  if (!row) return await conflict(scope, current.id, tx);
  await recordRevision(scope, tx, {
    entityType: "stream",
    entityId: row.id,
    projectId: row.projectId,
    revision: row.revision,
    document: row.document,
    changedBy: input.changedBy,
    changeReason: input.changeReason,
  });
  return { ok: true, row };
}

/**
 * Hard delete under the optimistic-concurrency clause. The cascade takes the
 * stream's tasks; `entity_revision` and `entity_link` rows survive, for the reasons
 * `repository/epic.ts` states.
 */
async function deleteStream(
  scope: WorkspaceScope,
  input: DeleteStreamInput,
  tx: DbTransaction,
): Promise<WriteResult<Stream>> {
  const [row] = await tx
    .delete(stream)
    .where(
      and(
        eq(stream.workspaceId, scope),
        eq(stream.id, input.id),
        eq(stream.revision, input.expectedRevision),
      ),
    )
    .returning();
  if (!row) {
    return await conflict(scope, input.id, tx);
  }
  return { ok: true, row };
}

/**
 * Re-hangs a stream under another epic, taking its tasks with it.
 *
 * Three things move together and none of them is enforced by a constraint: the
 * `epic_id` column, the `project_id` relationally denormalised onto the stream and
 * every task below it, and `links.parent_epic_id` inside the Stream document. The
 * target epic's project is the source of the new project id — an epic cannot be
 * in two projects, so asking it is more reliable than accepting one.
 *
 * The tasks' revisions are not bumped; see `repository/epic.ts`'s `move` for why.
 * Cross-project key collisions are rejected by the service before this write;
 * the table's unique constraint remains the final invariant.
 */
async function move(
  scope: WorkspaceScope,
  input: MoveStreamInput,
  tx: DbTransaction,
): Promise<WriteResult<Stream>> {
  const [target] = await tx
    .select({ id: epic.id, projectId: epic.projectId })
    .from(epic)
    .where(and(eq(epic.workspaceId, scope), eq(epic.id, input.epicId)))
    .limit(1);
  if (!target) {
    return { ok: false, reason: "not_found" };
  }
  const current = await findById(scope, input.id, tx);
  if (!current) {
    return { ok: false, reason: "not_found" };
  }

  const revision = input.expectedRevision + 1;
  const stamped = stampServerOwnedMeta(current.document, {
    id: current.id,
    key: current.key,
    revision,
    statuses: STREAM_STATUS,
    sections: { links: { parent_epic_id: target.id } },
  });
  const [row] = await tx
    .update(stream)
    .set({
      epicId: target.id,
      projectId: target.projectId,
      revision,
      title: stamped.title,
      status: stamped.status,
      streamType: readStreamType(stamped.document, current.key),
      document: stamped.document,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(stream.workspaceId, scope),
        eq(stream.id, current.id),
        eq(stream.revision, input.expectedRevision),
      ),
    )
    .returning();
  if (!row) {
    return await conflict(scope, current.id, tx);
  }
  await recordRevision(scope, tx, {
    entityType: "stream",
    entityId: row.id,
    projectId: row.projectId,
    revision: row.revision,
    document: row.document,
    changedBy: input.changedBy,
    changeReason: input.changeReason,
  });

  if (target.projectId !== current.projectId) {
    await tx
      .update(task)
      .set({
        projectId: target.projectId,
        updatedAt: new Date(),
      })
      .where(and(eq(task.workspaceId, scope), eq(task.streamId, current.id)));
  }

  return { ok: true, row };
}

/**
 * `stream_type` is derived from the document rather than accepted as a parameter,
 * for the same reason `title` and `status` are: the column and
 * `document.meta.stream_type` select the same thing — which content schema the
 * document was validated against — so a caller able to pass them separately could
 * make the row claim one type while its document is another.
 */
function readStreamType(document: Record<string, unknown>, key: string): StreamType {
  const meta: unknown = document.meta;
  const value =
    typeof meta === "object" && meta !== null
      ? (meta as Record<string, unknown>).stream_type
      : undefined;
  if (typeof value !== "string" || !(STREAM_TYPE as readonly string[]).includes(value)) {
    throw new DomainError(
      "document_invalid_stream_type",
      `Document for ${key} has meta.stream_type ${JSON.stringify(value)}, which is not one of ${STREAM_TYPE.join(", ")}.`,
    );
  }
  return value as StreamType;
}

async function conflict(
  scope: WorkspaceScope,
  id: string,
  tx: DbTransaction,
): Promise<WriteResult<Stream>> {
  const current = await findById(scope, id, tx);
  return current
    ? { ok: false, reason: "revision_conflict", current }
    : { ok: false, reason: "not_found" };
}

async function writeRevision(
  scope: WorkspaceScope,
  tx: DbTransaction,
  current: Stream,
  input: RevisionAuthor & {
    readonly expectedRevision: number;
    readonly document: Record<string, unknown>;
    readonly summary?: string | null;
    readonly sections?: Readonly<Record<string, Record<string, unknown>>>;
  },
): Promise<WriteResult<Stream>> {
  const revision = input.expectedRevision + 1;
  const stamped = stampServerOwnedMeta(input.document, {
    id: current.id,
    key: current.key,
    revision,
    statuses: STREAM_STATUS,
    sections: input.sections,
  });
  const [row] = await tx
    .update(stream)
    .set({
      status: stamped.status,
      revision,
      title: stamped.title,
      streamType: readStreamType(stamped.document, current.key),
      document: stamped.document,
      ...(input.summary === undefined ? {} : { summary: input.summary }),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(stream.workspaceId, scope),
        eq(stream.id, current.id),
        eq(stream.revision, input.expectedRevision),
      ),
    )
    .returning();
  if (!row) {
    return await conflict(scope, current.id, tx);
  }
  await recordRevision(scope, tx, {
    entityType: "stream",
    entityId: row.id,
    projectId: row.projectId,
    revision: row.revision,
    document: row.document,
    changedBy: input.changedBy,
    changeReason: input.changeReason,
  });
  return { ok: true, row };
}

export const streamRepository = {
  findById,
  findByKey,
  listByProject,
  listByEpic,
  listByMilestone,
  listRoadmapPositions,
  insert,
  bumpRevision,
  schedule,
  archive,
  delete: deleteStream,
  move,
};
