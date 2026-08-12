import { type SQL, and, eq, inArray, sql } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { DomainError } from "../../_/errors";
import { db, type Db } from "../../integration/drizzle/client";
import { entityRevision } from "../../integration/drizzle/schema/entityRevision";
import { epic } from "../../integration/drizzle/schema/epic";
import { project } from "../../integration/drizzle/schema/project";
import { stream } from "../../integration/drizzle/schema/stream";
import { task } from "../../integration/drizzle/schema/task";
import type { WorkspaceScope } from "../auth/workspaceScope";
import type { HierarchyEntityType, VersionedEntityType } from "../enums";
import { formatKey } from "../keys";
import { replaceOwnerFragments, replaceTaskBacklinks } from "./projectFragment";

/**
 * What the versioned entity repositories share: the transaction types, the
 * shape of a scoped write's outcome, the key counter, the revision log and the
 * stamping of server-owned document fields.
 *
 * The entity repositories are separate files because their columns, status
 * enums and relationships differ, and a table-generic factory over Drizzle needs
 * casts in exactly the code path where a cast is least acceptable — the tenant
 * filter. What is shared here is instead the part where copies would create
 * multiple chances to get concurrency wrong.
 *
 * Everything exported from `src/domain/repository/` takes `scope: WorkspaceScope`
 * first, including these helpers, and each one really does use it:
 * `issueKey` locates the project row inside the scope and `recordRevision` writes
 * the scope and project onto the audit row. Document JSON carries identity and
 * revision, while relational columns remain the sole ownership authority.
 */

/**
 * Anything that can run a query: the pool, or a transaction.
 *
 * Structural rather than `PgTransaction<…>`: naming that type means repeating the
 * client's four generic parameters here, and they change whenever the schema does.
 */
export type DbExecutor = Pick<
  Db,
  "select" | "selectDistinct" | "insert" | "update" | "delete" | "execute"
>;

/**
 * A real transaction, required by every write.
 *
 * Writes take this and not a `DbExecutor` on purpose. A key is issued by taking
 * `SELECT … FOR UPDATE` on the project row, and a row lock lives exactly as long
 * as the transaction that took it: run that on the pool in autocommit and the lock
 * is released before the insert, which is the one failure mode the counter design
 * exists to prevent. Making the transaction a parameter rather than opening one
 * per method is also what lets a change set be atomic — the pipeline opens one
 * transaction and every operation in the set writes inside it.
 */
export type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * The outcome of a scoped write. `ok: false` always means **nothing was written**.
 *
 * `not_found` covers both "no such id" and "that id belongs to another tenant",
 * deliberately indistinguishable: a caller who could tell them apart could probe
 * for the existence of another workspace's entities.
 *
 * `revision_conflict` carries `current`, the row as it stands now, because the
 * agent that lost the race needs to see what it collided with — its next move is
 * to re-read, merge and retry, and a bare "conflict" would force another round
 * trip to find out what changed.
 */
export type WriteResult<Row> =
  | { readonly ok: true; readonly row: Row }
  | { readonly ok: false; readonly reason: "not_found" }
  | { readonly ok: false; readonly reason: "revision_conflict"; readonly current: Row };

/** Every entity starts at revision 1 (the column's own default). */
export const FIRST_REVISION = 1;

/** Who is writing and why — recorded on every revision (domain spec §11, §12). */
export type RevisionAuthor = {
  /** Clerk user id, or the agent identity acting on their behalf. */
  readonly changedBy: string;
  readonly changeReason?: string | null;
};

/** Which counter column backs which entity's key. */
const COUNTER_FIELD = {
  epic: "epicCounter",
  stream: "streamCounter",
  task: "taskCounter",
  milestone: "milestoneCounter",
  rule: "ruleCounter",
} as const satisfies Record<VersionedEntityType, keyof typeof project.$inferSelect>;

/**
 * Issues the next key for an entity in a project, or `null` when the project is
 * not in this scope.
 *
 * `SELECT … FOR UPDATE` on the project row is the whole mechanism: the second
 * transaction asking for a key in the same project blocks on the lock until the
 * first commits, then reads the counter the first one wrote. No retry loop, no
 * unique-violation handling, and no `MAX(key) + 1` — which would read the same
 * number in both transactions and hand it to both. The lock is per project, so
 * work in different projects never waits on each other.
 *
 * Because the lock is held until the transaction ends, this must be called with a
 * real transaction (hence `DbTransaction`) and it must be called *inside* the
 * transaction that also inserts the row.
 */
export async function issueKey(
  scope: WorkspaceScope,
  tx: DbTransaction,
  input: { readonly entity: VersionedEntityType; readonly projectId: string },
): Promise<string | null> {
  const [row] = await tx
    .select()
    .from(project)
    .where(and(eq(project.workspaceId, scope), eq(project.id, input.projectId)))
    .for("update")
    .limit(1);
  if (!row) {
    return null;
  }
  const sequence = row[COUNTER_FIELD[input.entity]] + 1;
  await incrementCounter(scope, tx, input.entity, input.projectId, sequence);
  return formatKey(input.entity, sequence);
}

/**
 * A `switch` and not a computed property name: `set({ [field]: value })` widens to
 * an index signature that Drizzle's update type rejects, and the cast that would
 * silence it is not worth three lines.
 */
async function incrementCounter(
  scope: WorkspaceScope,
  tx: DbTransaction,
  entity: VersionedEntityType,
  projectId: string,
  sequence: number,
): Promise<void> {
  const where = and(eq(project.workspaceId, scope), eq(project.id, projectId));
  const updatedAt = new Date();
  switch (entity) {
    case "epic": {
      await tx.update(project).set({ epicCounter: sequence, updatedAt }).where(where);
      return;
    }
    case "stream": {
      await tx.update(project).set({ streamCounter: sequence, updatedAt }).where(where);
      return;
    }
    case "task": {
      await tx.update(project).set({ taskCounter: sequence, updatedAt }).where(where);
      return;
    }
    case "milestone": {
      await tx.update(project).set({ milestoneCounter: sequence, updatedAt }).where(where);
      return;
    }
    case "rule": {
      await tx.update(project).set({ ruleCounter: sequence, updatedAt }).where(where);
      return;
    }
  }
}

/** One entity, in the polymorphic form `entity_link` addresses an endpoint by. */
export type EntityEndpoint = {
  readonly type: HierarchyEntityType;
  readonly id: string;
};

export type DescendantEndpoint = EntityEndpoint & { readonly key: string };

export type HierarchyKeyCollision = {
  readonly type: HierarchyEntityType;
  readonly key: string;
};

/**
 * Existing destination rows that would collide with a moved subtree's stable
 * project-scoped keys. At most three fixed queries run, never one per entity.
 */
export async function findHierarchyKeyCollisions(
  scope: WorkspaceScope,
  executor: DbExecutor,
  input: {
    readonly projectId: string;
    readonly endpoints: readonly (EntityEndpoint & { readonly key: string })[];
  },
): Promise<readonly HierarchyKeyCollision[]> {
  const keys = <Type extends HierarchyEntityType>(type: Type): string[] =>
    input.endpoints.filter((endpoint) => endpoint.type === type).map((endpoint) => endpoint.key);
  const epicKeys = keys("epic");
  const streamKeys = keys("stream");
  const taskKeys = keys("task");
  const [epics, streams, tasks] = await Promise.all([
    epicKeys.length === 0
      ? Promise.resolve([])
      : executor
          .select({ key: epic.key })
          .from(epic)
          .where(
            and(
              eq(epic.workspaceId, scope),
              eq(epic.projectId, input.projectId),
              inArray(epic.key, epicKeys),
            ),
          ),
    streamKeys.length === 0
      ? Promise.resolve([])
      : executor
          .select({ key: stream.key })
          .from(stream)
          .where(
            and(
              eq(stream.workspaceId, scope),
              eq(stream.projectId, input.projectId),
              inArray(stream.key, streamKeys),
            ),
          ),
    taskKeys.length === 0
      ? Promise.resolve([])
      : executor
          .select({ key: task.key })
          .from(task)
          .where(
            and(
              eq(task.workspaceId, scope),
              eq(task.projectId, input.projectId),
              inArray(task.key, taskKeys),
            ),
          ),
  ]);
  return [
    ...epics.map((row) => ({ type: "epic" as const, key: row.key })),
    ...streams.map((row) => ({ type: "stream" as const, key: row.key })),
    ...tasks.map((row) => ({ type: "task" as const, key: row.key })),
  ].sort((left, right) => left.key.localeCompare(right.key));
}

/**
 * Everything the database will cascade-delete along with one entity.
 *
 * This exists because `entity_link`'s endpoints are polymorphic `(type, id)`
 * pairs, so they carry no foreign key and the database cannot cascade them.
 * Deleting an epic therefore deletes its streams and tasks through their real FKs
 * and leaves *their* edges behind — a dangling `blocked_by` the cycle check would
 * still walk through, pointing at an entity nobody can look up. The change-set
 * pipeline unlinks this whole list, which is the only way that cleanup can be
 * complete.
 *
 * It must be called **before** the delete: afterwards the descendants are gone and
 * there is nothing left to enumerate. That is one or two extra `SELECT`s on a
 * delete, which is the right trade against an unbounded number of orphan rows.
 *
 * Returns the descendants only, never the entity itself — the caller already holds
 * that endpoint, and including it would make "unlink the subtree" and "unlink the
 * entity" two spellings of one thing.
 */
export async function listDescendants(
  scope: WorkspaceScope,
  tx: DbTransaction,
  endpoint: EntityEndpoint,
): Promise<readonly DescendantEndpoint[]> {
  if (endpoint.type === "task") {
    return [];
  }
  if (endpoint.type === "stream") {
    const tasks = await tx
      .select({ id: task.id, key: task.key })
      .from(task)
      .where(and(eq(task.workspaceId, scope), eq(task.streamId, endpoint.id)));
    return tasks.map((row) => ({ type: "task", id: row.id, key: row.key }));
  }

  const streams = await tx
    .select({ id: stream.id, key: stream.key })
    .from(stream)
    .where(and(eq(stream.workspaceId, scope), eq(stream.epicId, endpoint.id)));
  const descendants: DescendantEndpoint[] = streams.map((row) => ({
    type: "stream",
    id: row.id,
    key: row.key,
  }));
  if (streams.length === 0) {
    return descendants;
  }
  // One statement for every task under the epic, joined through the stream rather
  // than one query per stream: an epic with thirty streams would otherwise cost
  // thirty round trips inside the delete's transaction.
  const tasks = await tx
    .select({ id: task.id, key: task.key })
    .from(task)
    .innerJoin(stream, eq(task.streamId, stream.id))
    .where(and(eq(task.workspaceId, scope), eq(stream.epicId, endpoint.id)));
  for (const row of tasks) {
    descendants.push({ type: "task", id: row.id, key: row.key });
  }
  return descendants;
}

/**
 * The highest sequence number any key in one project's `table` carries, or `0`.
 *
 * `split_part(key, '-', 2)::int` is safe because every key in these tables was
 * produced by `formatKey`, which is the only writer of the column and always emits
 * `PREFIX-<positive integer>`.
 */
const highestIssuedSequence = (
  scope: WorkspaceScope,
  projectId: string,
  table: PgTable,
  keyColumn: PgColumn,
  workspaceColumn: PgColumn,
  projectColumn: PgColumn,
): SQL =>
  sql`coalesce((select max(split_part(${keyColumn}, '-', 2)::int) from ${table} where ${workspaceColumn} = ${scope} and ${projectColumn} = ${projectId}), 0)`;

/**
 * Raises a project's three hierarchy key counters to the highest key each table
 * actually holds for it. Never lowers one. Rule and Milestone are not movable
 * hierarchy nodes, so their counters need no equivalent repair here.
 *
 * This exists because of `move`. Keys are unique per project and are never
 * rewritten, so moving a subtree into another project imports keys that project's
 * counters have never heard of: move `S-1..S-3` into a project whose
 * `stream_counter` is `0` and the next stream created there is issued `S-1`,
 * which collides with a row that is already sitting in the table. The change set
 * fails loudly on `stream_project_key_uniq` rather than corrupting anything, but
 * the target project's stream creation stays wedged until someone notices.
 *
 * One statement, and it reads the tables rather than accepting the moved
 * sequences as a parameter: a caller that computed them could compute them wrong,
 * and `GREATEST` over what is actually stored is idempotent — running it on a
 * project that never received a move changes nothing. The change-set pipeline
 * calls it inside the move's own transaction, so the counters and the moved rows
 * commit together.
 *
 * It does **not** take `SELECT … FOR UPDATE` of its own: it is an `UPDATE` of the
 * project row, which takes the same row lock `issueKey` waits on, so a concurrent
 * create in the target project either blocks until this commits or has already
 * committed its own increment before this reads.
 */
export async function raiseKeyCounters(
  scope: WorkspaceScope,
  tx: DbTransaction,
  projectId: string,
): Promise<void> {
  await tx
    .update(project)
    .set({
      epicCounter: sql`greatest(${project.epicCounter}, ${highestIssuedSequence(scope, projectId, epic, epic.key, epic.workspaceId, epic.projectId)})`,
      streamCounter: sql`greatest(${project.streamCounter}, ${highestIssuedSequence(scope, projectId, stream, stream.key, stream.workspaceId, stream.projectId)})`,
      taskCounter: sql`greatest(${project.taskCounter}, ${highestIssuedSequence(scope, projectId, task, task.key, task.workspaceId, task.projectId)})`,
      updatedAt: new Date(),
    })
    .where(and(eq(project.workspaceId, scope), eq(project.id, projectId)));
}

/** One exact audit snapshot, used when a terminal Task pins parent context. */
export async function findRevisionDocument(
  scope: WorkspaceScope,
  input: {
    readonly entity: VersionedEntityType;
    readonly id: string;
    readonly revision: number;
  },
  executor: DbExecutor = db,
): Promise<Record<string, unknown> | null> {
  const [row] = await executor
    .select({ document: entityRevision.document })
    .from(entityRevision)
    .where(
      and(
        eq(entityRevision.workspaceId, scope),
        eq(entityRevision.entityType, input.entity),
        eq(entityRevision.entityId, input.id),
        eq(entityRevision.revision, input.revision),
      ),
    )
    .limit(1);
  return row?.document ?? null;
}

/**
 * Appends the full document snapshot for one revision — the system's only audit
 * trail (domain spec §11 `every_change_is_recorded`).
 *
 * `entity_revision` is append-only, enforced by a trigger, so this can only ever
 * add. It is called inside the same transaction as the write it records, which is
 * what makes "a committed change always has its revision row" true rather than
 * likely.
 */
export async function recordRevision(
  scope: WorkspaceScope,
  tx: DbTransaction,
  input: {
    readonly entityType: VersionedEntityType;
    readonly entityId: string;
    readonly projectId: string;
    readonly revision: number;
    readonly document: Record<string, unknown>;
  } & RevisionAuthor,
): Promise<void> {
  await tx.insert(entityRevision).values({
    entityType: input.entityType,
    entityId: input.entityId,
    revision: input.revision,
    workspaceId: scope,
    projectId: input.projectId,
    document: input.document,
    changedBy: input.changedBy,
    changeReason: input.changeReason ?? null,
  });
  await replaceOwnerFragments(scope, tx, {
    entityType: input.entityType,
    entityId: input.entityId,
    projectId: input.projectId,
    document: input.document,
  });
  if (input.entityType === "task") {
    const meta = asRecord(input.document.meta);
    await replaceTaskBacklinks(scope, tx, {
      taskId: input.entityId,
      taskKey: typeof meta.key === "string" ? meta.key : "",
      projectId: input.projectId,
      document: input.document,
    });
  }
}

export type StampInput<Status extends string> = {
  readonly id: string;
  readonly key: string;
  readonly revision: number;
  /**
   * The status values this entity accepts, so the value that lands in the `status`
   * column is checked against the same enum the column is typed with instead of
   * being cast.
   */
  readonly statuses: readonly Status[];
  /**
   * Sections to replace before stamping — `{ meta: { status: "archived" } }` or
   * `{ links: { parent_epic_id: "…" } }`. Replacement is per section, one level
   * below the document's groups, the same granularity an agent's `update` gets
   * from `changeSet/patch.ts`.
   *
   * The merge lives here rather than importing that module because the dependency
   * would point the wrong way: `changeSet/` is the caller's vocabulary and sits
   * above persistence. These are the server's own two known-good edits, not
   * arbitrary agent input, so they need none of the validation that module does.
   */
  readonly sections?: Readonly<Record<string, Record<string, unknown>>>;
};

export type StampedDocument<Status extends string> = {
  /** The document as it will be stored. */
  readonly document: Record<string, unknown>;
  /** `meta.title`, for the denormalised column. */
  readonly title: string;
  /** `meta.status`, for the denormalised column. */
  readonly status: Status;
};

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/**
 * Writes the three server-owned identity/revision fields into the document, and
 * reads back the two fields the row denormalises.
 *
 * This runs on every insert and every revision bump, last, unconditionally. That
 * is what makes `meta.id`, `meta.key` and `meta.revision` unforgeable end to end:
 * the agent-tier schema rejects them on the way in, and anything that still
 * reached the document — from a merge, from a document read back at store tier,
 * from a future caller — is overwritten here with the values of the row actually
 * being written. Project and workspace ownership are intentionally absent from
 * document JSON; their relational columns are the single authority.
 *
 * `title` and `status` are returned rather than accepted as parameters for the
 * same reason in reverse: they are *derived* from the document, so the column and
 * the document cannot disagree about what an entity is called or what state it is
 * in. A caller that could pass them separately could make them disagree.
 */
export function stampServerOwnedMeta<Status extends string>(
  document: Record<string, unknown>,
  input: StampInput<Status>,
): StampedDocument<Status> {
  const next: Record<string, unknown> = { ...document };
  for (const [group, sections] of Object.entries(input.sections ?? {})) {
    next[group] = { ...asRecord(next[group]), ...sections };
  }

  // Annotated rather than inferred: spreading a `Record<string, unknown>` into an
  // object literal with known keys loses the index signature, and `meta.title` is
  // then not addressable at all.
  const meta: Record<string, unknown> = {
    ...asRecord(next.meta),
    id: input.id,
    key: input.key,
    revision: input.revision,
  };
  // A legacy location copy must not survive into a v2 revision. Descendant rows
  // can then move projects without rewriting their immutable document history.
  delete meta.project_id;
  delete meta.workspace_id;
  next.meta = meta;

  const { title, status } = meta;
  // A document without a title or with a status outside its enum cannot have come
  // through `parseDocument`, which every write path goes through first. Throwing
  // beats writing a row whose columns are a guess: this is a wiring defect, not a
  // state a user can be in.
  if (typeof title !== "string" || title.length === 0) {
    throw new DomainError(
      "document_missing_title",
      `Document for ${input.key} has no meta.title, so the title column cannot be derived.`,
    );
  }
  if (typeof status !== "string" || !(input.statuses as readonly string[]).includes(status)) {
    throw new DomainError(
      "document_invalid_status",
      `Document for ${input.key} has meta.status ${JSON.stringify(status)}, which is not one of ${input.statuses.join(", ")}.`,
    );
  }
  return { document: next, title, status: status as Status };
}
