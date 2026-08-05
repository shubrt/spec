import { and, asc, eq, sql } from "drizzle-orm";
import { DomainError } from "../../_/errors";
import { db } from "../../integration/drizzle/client";
import { epic } from "../../integration/drizzle/schema/epic";
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
  const stamped = stampServerOwnedMeta(scope, input.document, {
    id,
    key,
    projectId: input.projectId,
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
 * `epic_id` column, the `project_id` denormalised onto the stream and every task
 * below it, and `links.parent_epic_id` inside the document. The target epic's
 * project is the source of the new project id — an epic cannot be in two projects,
 * so asking it is more reliable than accepting one.
 *
 * The tasks' revisions are not bumped; see `repository/epic.ts`'s `move` for why.
 * The same key-uniqueness limitation applies when the move crosses projects.
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
  const stamped = stampServerOwnedMeta(scope, current.document, {
    id: current.id,
    key: current.key,
    projectId: target.projectId,
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
        // `meta.project_id` rewritten server-side: see `repository/epic.ts`.
        document: sql`jsonb_set(${task.document}, '{meta,project_id}', to_jsonb(${target.projectId}::text))`,
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
  const stamped = stampServerOwnedMeta(scope, input.document, {
    id: current.id,
    key: current.key,
    projectId: current.projectId,
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
  insert,
  bumpRevision,
  archive,
  delete: deleteStream,
  move,
};
