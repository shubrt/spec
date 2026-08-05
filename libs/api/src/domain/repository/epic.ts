import { and, eq, inArray, sql } from "drizzle-orm";
import { DomainError } from "../../_/errors";
import { db } from "../../integration/drizzle/client";
import { epic } from "../../integration/drizzle/schema/epic";
import { project } from "../../integration/drizzle/schema/project";
import { stream } from "../../integration/drizzle/schema/stream";
import { task } from "../../integration/drizzle/schema/task";
import type { WorkspaceScope } from "../auth/workspaceScope";
import { EPIC_STATUS } from "../enums";
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
 * The epic aggregate — the top of the planning hierarchy (domain spec §3.1).
 *
 * ## Optimistic concurrency is a `WHERE` clause
 *
 * Every write that touches an existing row carries
 * `AND revision = $expectedRevision` in its `WHERE`. Zero affected rows means
 * someone else committed first; the row is then re-read and returned as
 * `revision_conflict` so the agent can see what it collided with. There is no
 * place in this file where a revision is read, compared in TypeScript and then
 * written — that version has a window between the read and the write in which the
 * check has already been passed, and it would pass every test that does not run two
 * writers at once. `test/db/entityRepository.db.test.ts` runs two.
 *
 * The pre-read some methods do is *not* that check: it fetches the key and project
 * id needed to stamp the document, and the concurrency decision still happens in
 * the `WHERE` clause afterwards.
 *
 * ## Claiming is not a mechanism
 *
 * There are no lease columns, no `claimNext`, no stale-claim recovery and no cron.
 * Claiming work is `status = in_progress` plus an assignee under an
 * `expected_revision`, which means two agents racing for the same task produce one
 * winner and one `revision_conflict`. The accepted consequence is that a crashed
 * agent leaves a task on `in_progress` until someone resets it — that is a human
 * decision with a human's context, and a timeout would guess.
 */

export type Epic = typeof epic.$inferSelect;

export type InsertEpicInput = RevisionAuthor & {
  readonly projectId: string;
  /** The document as `parseDocument` returned it. Server-owned `meta` is stamped over. */
  readonly document: Record<string, unknown>;
  /** One-line abstract for listing and search. */
  readonly summary?: string | null;
};

export type UpdateEpicInput = RevisionAuthor & {
  readonly id: string;
  readonly expectedRevision: number;
  readonly document: Record<string, unknown>;
  /** Omitted leaves the stored summary alone; `null` clears it. */
  readonly summary?: string | null;
};

export type ArchiveEpicInput = RevisionAuthor & {
  readonly id: string;
  readonly expectedRevision: number;
};

export type DeleteEpicInput = {
  readonly id: string;
  readonly expectedRevision: number;
};

export type MoveEpicInput = RevisionAuthor & {
  readonly id: string;
  readonly expectedRevision: number;
  /** The project the epic and its whole subtree move into. */
  readonly projectId: string;
};

/**
 * An epic leaves the picture as `archived`, the terminal value of its own status
 * ladder (`domain/enums.ts`: an epic has no `done`, because finishing a stream does
 * not finish the capability).
 */
const ARCHIVED: (typeof EPIC_STATUS)[number] = "archived";

async function findById(
  scope: WorkspaceScope,
  id: string,
  executor: DbExecutor = db,
): Promise<Epic | null> {
  const [row] = await executor
    .select()
    .from(epic)
    .where(and(eq(epic.workspaceId, scope), eq(epic.id, id)))
    .limit(1);
  return row ?? null;
}

/**
 * A key is unique per project, not per workspace, so the project is part of the
 * lookup. `EPIC-1` exists in every project.
 */
async function findByKey(
  scope: WorkspaceScope,
  input: { readonly projectId: string; readonly key: string },
  executor: DbExecutor = db,
): Promise<Epic | null> {
  const [row] = await executor
    .select()
    .from(epic)
    .where(
      and(
        eq(epic.workspaceId, scope),
        eq(epic.projectId, input.projectId),
        eq(epic.key, input.key),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function insert(
  scope: WorkspaceScope,
  input: InsertEpicInput,
  tx: DbTransaction,
): Promise<WriteResult<Epic>> {
  const key = await issueKey(scope, tx, { entity: "epic", projectId: input.projectId });
  if (key === null) {
    return { ok: false, reason: "not_found" };
  }
  // The id is generated here rather than by the column default so that the
  // document can carry `meta.id` in the same statement that writes the row.
  const id = crypto.randomUUID();
  const stamped = stampServerOwnedMeta(scope, input.document, {
    id,
    key,
    projectId: input.projectId,
    revision: FIRST_REVISION,
    statuses: EPIC_STATUS,
  });
  const [row] = await tx
    .insert(epic)
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
    })
    .returning();
  if (!row) {
    throw new DomainError("insert_returned_no_row", `Insert of epic ${key} returned no row.`);
  }
  await recordRevision(scope, tx, {
    entityType: "epic",
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
  input: UpdateEpicInput,
  tx: DbTransaction,
): Promise<WriteResult<Epic>> {
  const current = await findById(scope, input.id, tx);
  if (!current) {
    return { ok: false, reason: "not_found" };
  }
  return await writeRevision(scope, tx, current, input);
}

async function archive(
  scope: WorkspaceScope,
  input: ArchiveEpicInput,
  tx: DbTransaction,
): Promise<WriteResult<Epic>> {
  const current = await findById(scope, input.id, tx);
  if (!current) {
    return { ok: false, reason: "not_found" };
  }
  // Archiving is an ordinary revision whose only edit is the status, so it lands in
  // `entity_revision` like any other change and the document's `meta.status` cannot
  // drift from the column.
  return await writeRevision(scope, tx, current, {
    ...input,
    document: current.document,
    sections: { meta: { status: ARCHIVED } },
  });
}

/**
 * Hard delete under the same optimistic-concurrency clause.
 *
 * The FK cascade takes the epic's streams and tasks with it. Two things it does
 * not take: `entity_revision` rows, which have no FK to the entity and are
 * append-only, so the history of a deleted epic survives on purpose; and
 * `entity_link` rows, whose endpoints are polymorphic and therefore unconstrained —
 * the change-set pipeline unlinks what it deletes.
 *
 * No revision is appended: the last state is already the last row in the log, and
 * a "deleted" snapshot would be a document that never existed.
 */
async function deleteEpic(
  scope: WorkspaceScope,
  input: DeleteEpicInput,
  tx: DbTransaction,
): Promise<WriteResult<Epic>> {
  const [row] = await tx
    .delete(epic)
    .where(
      and(
        eq(epic.workspaceId, scope),
        eq(epic.id, input.id),
        eq(epic.revision, input.expectedRevision),
      ),
    )
    .returning();
  if (!row) {
    return await conflict(scope, input.id, tx);
  }
  return { ok: true, row };
}

/**
 * Moves an epic — and its whole subtree — into another project of the same
 * workspace.
 *
 * `project_id` is denormalised onto every stream and task row (and into their
 * documents' `meta.project_id`), and the FKs are single-column, so the database
 * will **not** notice a subtree left half-moved. Nothing here is optional
 * therefore: the epic, its streams and their tasks are rewritten in one
 * transaction, and `test/db/move.db.test.ts` is what enforces it, since no
 * constraint can.
 *
 * `workspace_id` is never rewritten. A move across tenants is not a move, and
 * every statement below is filtered by the scope, so an attempt to name another
 * workspace's project ends as `not_found`.
 *
 * The descendants' revisions are deliberately **not** bumped. Their documents
 * change only in the denormalised copy of a fact that changed elsewhere, and
 * bumping them would invalidate the `expected_revision` every agent currently
 * holds for every entity in the subtree — a move would then make an unrelated
 * stream's next write fail. The move itself is recorded on the epic, which is where
 * it happened.
 *
 * **Known limitation:** keys are per project and are never rewritten, so moving
 * into a project that has already issued the same numbers fails on
 * `epic_project_key_uniq` (or the stream/task equivalent) and the change set
 * aborts with nothing written. Re-keying the subtree was rejected — a key is a
 * permanent external reference, and reissuing it would silently repoint every
 * mention of it. Note also that the target project's counters do not learn about
 * the keys that moved in; see the report's concerns.
 */
async function move(
  scope: WorkspaceScope,
  input: MoveEpicInput,
  tx: DbTransaction,
): Promise<WriteResult<Epic>> {
  const [target] = await tx
    .select({ id: project.id })
    .from(project)
    .where(and(eq(project.workspaceId, scope), eq(project.id, input.projectId)))
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
    projectId: input.projectId,
    revision,
    statuses: EPIC_STATUS,
  });
  const [row] = await tx
    .update(epic)
    .set({
      projectId: input.projectId,
      revision,
      title: stamped.title,
      status: stamped.status,
      document: stamped.document,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(epic.workspaceId, scope),
        eq(epic.id, current.id),
        eq(epic.revision, input.expectedRevision),
      ),
    )
    .returning();
  if (!row) {
    return await conflict(scope, current.id, tx);
  }
  await recordRevision(scope, tx, {
    entityType: "epic",
    entityId: row.id,
    projectId: row.projectId,
    revision: row.revision,
    document: row.document,
    changedBy: input.changedBy,
    changeReason: input.changeReason,
  });

  // The subtree is selected by parent, never by the old project id: the epic's own
  // row has already changed, and a subtree is defined by who its parent is.
  const streamsOfEpic = tx
    .select({ id: stream.id })
    .from(stream)
    .where(and(eq(stream.workspaceId, scope), eq(stream.epicId, current.id)));
  await tx
    .update(task)
    .set({
      projectId: input.projectId,
      document: reprojectedDocument(task.document, input.projectId),
      updatedAt: new Date(),
    })
    .where(and(eq(task.workspaceId, scope), inArray(task.streamId, streamsOfEpic)));
  await tx
    .update(stream)
    .set({
      projectId: input.projectId,
      document: reprojectedDocument(stream.document, input.projectId),
      updatedAt: new Date(),
    })
    .where(and(eq(stream.workspaceId, scope), eq(stream.epicId, current.id)));

  return { ok: true, row };
}

/**
 * `meta.project_id` rewritten in place, server-side.
 *
 * In SQL rather than read-modify-write in TypeScript: a subtree is unbounded in
 * size, and one statement per row would turn a move into N round trips inside the
 * lock. `jsonb_set` leaves a document without a `meta` object untouched rather than
 * failing, which is the right behaviour for a denormalised copy.
 */
const reprojectedDocument = (
  column: typeof stream.document | typeof task.document,
  projectId: string,
) => sql`jsonb_set(${column}, '{meta,project_id}', to_jsonb(${projectId}::text))`;

/**
 * Zero affected rows. Either the revision moved under us or the row is not in this
 * scope, and the row itself is the only thing that can tell the two apart.
 */
async function conflict(
  scope: WorkspaceScope,
  id: string,
  tx: DbTransaction,
): Promise<WriteResult<Epic>> {
  const current = await findById(scope, id, tx);
  return current
    ? { ok: false, reason: "revision_conflict", current }
    : { ok: false, reason: "not_found" };
}

async function writeRevision(
  scope: WorkspaceScope,
  tx: DbTransaction,
  current: Epic,
  input: RevisionAuthor & {
    readonly expectedRevision: number;
    readonly document: Record<string, unknown>;
    readonly summary?: string | null;
    readonly sections?: Readonly<Record<string, Record<string, unknown>>>;
  },
): Promise<WriteResult<Epic>> {
  // Safe because the `WHERE` below only matches when `revision` really is
  // `expectedRevision`; if it is not, nothing is written and the value is unused.
  const revision = input.expectedRevision + 1;
  const stamped = stampServerOwnedMeta(scope, input.document, {
    id: current.id,
    key: current.key,
    projectId: current.projectId,
    revision,
    statuses: EPIC_STATUS,
    sections: input.sections,
  });
  const [row] = await tx
    .update(epic)
    .set({
      status: stamped.status,
      revision,
      title: stamped.title,
      document: stamped.document,
      ...(input.summary === undefined ? {} : { summary: input.summary }),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(epic.workspaceId, scope),
        eq(epic.id, current.id),
        eq(epic.revision, input.expectedRevision),
      ),
    )
    .returning();
  if (!row) {
    return await conflict(scope, current.id, tx);
  }
  await recordRevision(scope, tx, {
    entityType: "epic",
    entityId: row.id,
    projectId: row.projectId,
    revision: row.revision,
    document: row.document,
    changedBy: input.changedBy,
    changeReason: input.changeReason,
  });
  return { ok: true, row };
}

export const epicRepository = {
  findById,
  findByKey,
  insert,
  bumpRevision,
  archive,
  delete: deleteEpic,
  move,
};
