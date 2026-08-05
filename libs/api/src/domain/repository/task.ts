import { and, eq } from "drizzle-orm";
import { DomainError } from "../../_/errors";
import { db } from "../../integration/drizzle/client";
import { stream } from "../../integration/drizzle/schema/stream";
import { task } from "../../integration/drizzle/schema/task";
import type { WorkspaceScope } from "../auth/workspaceScope";
import { TASK_STATUS, TASK_TYPE, type TaskType } from "../enums";
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
 * The task aggregate — a concrete technical unit of work under a stream (domain
 * spec §3.3). `repository/epic.ts` carries the full rationale for the
 * optimistic-concurrency clause; this file follows it exactly.
 *
 * ## Claiming a task
 *
 * There is no `claim` method, and that is the design. Picking work up is an
 * ordinary `bumpRevision` whose document sets `meta.status` to `in_progress` and
 * `execution.assignee` to the agent, under the `expected_revision` the agent read.
 * Two agents that go for the same task both send `expected_revision: 3`; one write
 * matches the `WHERE`, the other affects zero rows and comes back as
 * `revision_conflict` with the winner's row attached, which tells the loser who
 * took it. A lease column would add a second concurrency mechanism next to the one
 * that already works, plus an expiry nobody can set correctly, plus a job to
 * reclaim what expired.
 */

export type Task = typeof task.$inferSelect;

export type InsertTaskInput = RevisionAuthor & {
  readonly projectId: string;
  readonly streamId: string;
  readonly document: Record<string, unknown>;
  readonly summary?: string | null;
};

export type UpdateTaskInput = RevisionAuthor & {
  readonly id: string;
  readonly expectedRevision: number;
  readonly document: Record<string, unknown>;
  /** Omitted leaves the stored summary alone; `null` clears it. */
  readonly summary?: string | null;
};

export type ArchiveTaskInput = RevisionAuthor & {
  readonly id: string;
  readonly expectedRevision: number;
};

export type DeleteTaskInput = {
  readonly id: string;
  readonly expectedRevision: number;
};

export type MoveTaskInput = RevisionAuthor & {
  readonly id: string;
  readonly expectedRevision: number;
  /** The stream the task moves under; its project comes with it. */
  readonly streamId: string;
};

/** A task that is not being done is `cancelled`; `done` means it was finished. */
const ARCHIVED: (typeof TASK_STATUS)[number] = "cancelled";

async function findById(
  scope: WorkspaceScope,
  id: string,
  executor: DbExecutor = db,
): Promise<Task | null> {
  const [row] = await executor
    .select()
    .from(task)
    .where(and(eq(task.workspaceId, scope), eq(task.id, id)))
    .limit(1);
  return row ?? null;
}

/** A key is unique per project, so the project is part of the lookup. */
async function findByKey(
  scope: WorkspaceScope,
  input: { readonly projectId: string; readonly key: string },
  executor: DbExecutor = db,
): Promise<Task | null> {
  const [row] = await executor
    .select()
    .from(task)
    .where(
      and(
        eq(task.workspaceId, scope),
        eq(task.projectId, input.projectId),
        eq(task.key, input.key),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function insert(
  scope: WorkspaceScope,
  input: InsertTaskInput,
  tx: DbTransaction,
): Promise<WriteResult<Task>> {
  const key = await issueKey(scope, tx, { entity: "task", projectId: input.projectId });
  if (key === null) {
    return { ok: false, reason: "not_found" };
  }
  const id = crypto.randomUUID();
  const stamped = stampServerOwnedMeta(scope, input.document, {
    id,
    key,
    projectId: input.projectId,
    revision: FIRST_REVISION,
    statuses: TASK_STATUS,
    sections: { links: { parent_stream_id: input.streamId } },
  });
  const [row] = await tx
    .insert(task)
    .values({
      id,
      workspaceId: scope,
      projectId: input.projectId,
      streamId: input.streamId,
      key,
      taskType: readTaskType(stamped.document, key),
      status: stamped.status,
      revision: FIRST_REVISION,
      title: stamped.title,
      summary: input.summary ?? null,
      document: stamped.document,
    })
    .returning();
  if (!row) {
    throw new DomainError("insert_returned_no_row", `Insert of task ${key} returned no row.`);
  }
  await recordRevision(scope, tx, {
    entityType: "task",
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
  input: UpdateTaskInput,
  tx: DbTransaction,
): Promise<WriteResult<Task>> {
  const current = await findById(scope, input.id, tx);
  if (!current) {
    return { ok: false, reason: "not_found" };
  }
  return await writeRevision(scope, tx, current, input);
}

async function archive(
  scope: WorkspaceScope,
  input: ArchiveTaskInput,
  tx: DbTransaction,
): Promise<WriteResult<Task>> {
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
 * Hard delete under the optimistic-concurrency clause. A task has no children;
 * `entity_revision` and `entity_link` rows survive, for the reasons
 * `repository/epic.ts` states.
 */
async function deleteTask(
  scope: WorkspaceScope,
  input: DeleteTaskInput,
  tx: DbTransaction,
): Promise<WriteResult<Task>> {
  const [row] = await tx
    .delete(task)
    .where(
      and(
        eq(task.workspaceId, scope),
        eq(task.id, input.id),
        eq(task.revision, input.expectedRevision),
      ),
    )
    .returning();
  if (!row) {
    return await conflict(scope, input.id, tx);
  }
  return { ok: true, row };
}

/**
 * Re-hangs a task under another stream. The target stream's project is the source
 * of the new project id, and `links.parent_stream_id` moves with the column. A task
 * has no subtree, so this is the one `move` in the layer where nothing below it can
 * be left behind.
 */
async function move(
  scope: WorkspaceScope,
  input: MoveTaskInput,
  tx: DbTransaction,
): Promise<WriteResult<Task>> {
  const [target] = await tx
    .select({ id: stream.id, projectId: stream.projectId })
    .from(stream)
    .where(and(eq(stream.workspaceId, scope), eq(stream.id, input.streamId)))
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
    statuses: TASK_STATUS,
    sections: { links: { parent_stream_id: target.id } },
  });
  const [row] = await tx
    .update(task)
    .set({
      streamId: target.id,
      projectId: target.projectId,
      revision,
      title: stamped.title,
      status: stamped.status,
      taskType: readTaskType(stamped.document, current.key),
      document: stamped.document,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(task.workspaceId, scope),
        eq(task.id, current.id),
        eq(task.revision, input.expectedRevision),
      ),
    )
    .returning();
  if (!row) {
    return await conflict(scope, current.id, tx);
  }
  await recordRevision(scope, tx, {
    entityType: "task",
    entityId: row.id,
    projectId: row.projectId,
    revision: row.revision,
    document: row.document,
    changedBy: input.changedBy,
    changeReason: input.changeReason,
  });
  return { ok: true, row };
}

/** Derived from the document for the same reason as `title` and `status`. */
function readTaskType(document: Record<string, unknown>, key: string): TaskType {
  const meta: unknown = document.meta;
  const value =
    typeof meta === "object" && meta !== null
      ? (meta as Record<string, unknown>).task_type
      : undefined;
  if (typeof value !== "string" || !(TASK_TYPE as readonly string[]).includes(value)) {
    throw new DomainError(
      "document_invalid_task_type",
      `Document for ${key} has meta.task_type ${JSON.stringify(value)}, which is not one of ${TASK_TYPE.join(", ")}.`,
    );
  }
  return value as TaskType;
}

async function conflict(
  scope: WorkspaceScope,
  id: string,
  tx: DbTransaction,
): Promise<WriteResult<Task>> {
  const current = await findById(scope, id, tx);
  return current
    ? { ok: false, reason: "revision_conflict", current }
    : { ok: false, reason: "not_found" };
}

async function writeRevision(
  scope: WorkspaceScope,
  tx: DbTransaction,
  current: Task,
  input: RevisionAuthor & {
    readonly expectedRevision: number;
    readonly document: Record<string, unknown>;
    readonly summary?: string | null;
    readonly sections?: Readonly<Record<string, Record<string, unknown>>>;
  },
): Promise<WriteResult<Task>> {
  const revision = input.expectedRevision + 1;
  const stamped = stampServerOwnedMeta(scope, input.document, {
    id: current.id,
    key: current.key,
    projectId: current.projectId,
    revision,
    statuses: TASK_STATUS,
    sections: input.sections,
  });
  const [row] = await tx
    .update(task)
    .set({
      status: stamped.status,
      revision,
      title: stamped.title,
      taskType: readTaskType(stamped.document, current.key),
      document: stamped.document,
      ...(input.summary === undefined ? {} : { summary: input.summary }),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(task.workspaceId, scope),
        eq(task.id, current.id),
        eq(task.revision, input.expectedRevision),
      ),
    )
    .returning();
  if (!row) {
    return await conflict(scope, current.id, tx);
  }
  await recordRevision(scope, tx, {
    entityType: "task",
    entityId: row.id,
    projectId: row.projectId,
    revision: row.revision,
    document: row.document,
    changedBy: input.changedBy,
    changeReason: input.changeReason,
  });
  return { ok: true, row };
}

export const taskRepository = {
  findById,
  findByKey,
  insert,
  bumpRevision,
  archive,
  delete: deleteTask,
  move,
};
