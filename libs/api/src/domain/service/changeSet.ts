import type { z } from "zod";
import { DomainError } from "../../_/errors";
import { db } from "../../integration/drizzle/client";
import type { WorkspaceAuthContext } from "../auth/authContext";
import type { WorkspaceScope } from "../auth/workspaceScope";
import { applySectionPatch } from "../changeSet/patch";
import { type PlanRef, type PlannedOperation, planChangeSet } from "../changeSet/plan";
import { type ChangeSet, type ChangeSetOperationKind, changeSetSchema } from "../changeSet/schema";
import type { EntityType } from "../enums";
import { findDependencyCycle } from "../graph/cycle";
import {
  type DbTransaction,
  type WriteResult,
  listDescendants,
  raiseKeyCounters,
} from "../repository/entity";
import { entityLinkRepository } from "../repository/entityLink";
import { epicRepository } from "../repository/epic";
import { streamRepository } from "../repository/stream";
import { taskRepository } from "../repository/task";
import { type Project, workspaceRepository } from "../repository/workspace";
import {
  EPIC_SCHEMA_VERSION,
  STREAM_SCHEMA_VERSION,
  TASK_SCHEMA_VERSION,
  parseDocument,
} from "../schema/document";
import { type DocumentIssue, ruleIssue, shapeIssue } from "../schema/rules";

/**
 * The change-set pipeline — the single write path into the whole system.
 *
 * Every mutation an agent makes arrives here, and nothing outside this file
 * writes `epic`, `stream`, `task`, `entity_link` or `entity_revision`.
 *
 * ## One function, one `mode`
 *
 * `validate_change_set` and `apply_change_set` are the *same* run. There is one
 * pipeline and one `shouldCommit` decision. It controls the only two observable
 * differences: validation does not enforce user consent for a destructive
 * operation it cannot persist, and its transaction is rolled back instead of
 * committed. Every schema, reference, document, readiness, cycle, OCC and write
 * simulation stage remains shared. That is not tidiness. `validate_change_set` is the designated
 * feedback channel for every domain rule that is invisible in the JSON Schema a
 * model sees — `z.toJSONSchema()` silently drops `.refine()` — so the moment a dry
 * run stops predicting the real thing, the only channel that can teach an agent
 * the rules starts lying to it. Two code paths is how that happens, so there is
 * one pipeline and exactly one mode decision.
 *
 * ## The tier follows the written status
 *
 * Nothing here accepts a "this is a draft" flag from the caller. `parseDocument`
 * derives the readiness tier from the `meta.status` that is actually being
 * written, so an agent cannot claim `draft` while storing `ready` and walk past
 * every domain spec §11 gate. The same reason `actor` and `workspace` are absent
 * from the change-set schema: they come from the `AuthContext` a verified token
 * produced, and there is no field to forge them in.
 *
 * ## Pipeline order
 *
 * 1. schema parse · 2. temp-id plan · 3. reference resolution · 4. document parse
 * in the right tier · 5. readiness (inside `parseDocument`) · 6. cycle check ·
 * 7. the apply-only `confirm` gate · 8. the write, under OCC.
 *
 * Stages 3–5, 7 and 8 run **per operation** rather than as whole-set passes, and
 * that is forced rather than chosen: a temp id resolves to a real id only once the
 * `create` that declares it has run, and the parent id is part of the document
 * that stage 4 parses. Validating the whole set first would mean parsing every
 * document twice — once against a placeholder parent, once against the real one —
 * which is the second code path this file exists to not have. Stage 6 runs once
 * after the loop, because a cycle is a property of the finished graph. Nothing is
 * observable before the commit decision either way: a refusal at any stage rolls
 * the transaction back, so "nothing was written" holds for all of them.
 */

export type ChangeSetMode = "validate" | "apply";

/**
 * Everything the pipeline needs that does not come from the agent.
 *
 * `auth` is the whole context and not a bare scope: the acting identity is
 * recorded on every revision, and taking both from one verified object is what
 * makes it impossible for a change set to be written under someone else's name.
 */
export type ChangeSetRequest = {
  readonly auth: WorkspaceAuthContext;
  /** The raw tool input. Parsed here, so an unvalidated object cannot slip past. */
  readonly input: unknown;
};

/** What one operation did, in submitted order. */
export type AppliedOperation = {
  /** Position in the submitted change set, so a report can name the operation. */
  readonly index: number;
  readonly operation: ChangeSetOperationKind;
  /** `null` for `link` and `unlink`, which act on a pair rather than an entity. */
  readonly entity: EntityType | null;
  readonly key: string | null;
  readonly id: string | null;
  /** The revision the entity now stands at, or `null` where nothing was versioned. */
  readonly revision: number | null;
  /** The temp id a `create` declared, so an agent can match it to the issued key. */
  readonly ref: string | null;
};

/** The entity as it stands now, handed back when a write lost the race for it. */
export type ConflictingEntity = {
  readonly entity: EntityType;
  readonly id: string;
  readonly key: string;
  readonly revision: number;
  readonly document: Record<string, unknown>;
};

/**
 * What a run produced. `code` is what a tool body turns into an `isError` result.
 *
 * `invalid_change_set` is the wide one on purpose: a malformed schema, an
 * impossible plan, a reference that does not resolve, a document that fails its
 * shape or its readiness gate, and a dependency cycle are all "here is what is
 * wrong, in `DocumentIssue`s with paths" — one shape for the one feedback channel.
 * The other two are not issues about the document: one is a decision a human still
 * has to make, the other is a race with another writer.
 */
export type ChangeSetOutcome =
  | { readonly ok: true; readonly applied: readonly AppliedOperation[] }
  | {
      readonly ok: false;
      readonly code: "invalid_change_set";
      readonly issues: readonly DocumentIssue[];
    }
  | {
      readonly ok: false;
      readonly code: "destructive_requires_confirm";
      readonly index: number;
      readonly operation: ChangeSetOperationKind;
      readonly key: string;
      readonly message: string;
    }
  | {
      readonly ok: false;
      readonly code: "revision_conflict";
      readonly index: number;
      readonly key: string;
      readonly expectedRevision: number;
      readonly current: ConflictingEntity;
      readonly message: string;
    };

/** A failure, which is also what any stage returns to stop the run. */
type Refusal = Extract<ChangeSetOutcome, { ok: false }>;

/**
 * Runs a change set, either as a dry run or for real.
 *
 * `ok: false` always means **nothing was written**, in both senses: the
 * transaction rolled back, and no key was consumed — a key is issued under a row
 * lock inside the same transaction, so a rollback hands the number to the next
 * writer instead of burning it.
 */
export async function runChangeSet(
  mode: ChangeSetMode,
  request: ChangeSetRequest,
): Promise<ChangeSetOutcome> {
  // 1. The schema. Everything downstream may assume the shape.
  const parsed = changeSetSchema.safeParse(request.input);
  if (!parsed.success) {
    return { ok: false, code: "invalid_change_set", issues: zodIssues(parsed.error.issues) };
  }

  // 2. The temp-id plan: references resolved into an execution order in which
  //    every `create` runs before the operations that name it.
  const planned = planChangeSet(parsed.data);
  if (!planned.ok) {
    return { ok: false, code: "invalid_change_set", issues: planned.issues };
  }

  // One decision feeds both places where validation must differ: simulating an
  // unconfirmed destructive operation is safe inside a rollback-only transaction,
  // while apply must refuse it before the write and then commit only on success.
  const shouldCommit = mode === "apply";

  // 3–8, in one transaction. `TransactionRollback` is how a refusal — and a dry
  // run — leaves the transaction: Drizzle rolls back on any throw, so carrying
  // the outcome out through the exception is what lets the decision be made in
  // one place instead of once per failure mode.
  try {
    return await db.transaction(async (tx) => {
      const outcome = await executePlan(
        {
          tx,
          scope: request.auth.scope,
          actor: request.auth.userId,
          reason: parsed.data.reason,
          changeSet: parsed.data,
          enforceConfirmation: shouldCommit,
          resolvedByTemp: new Map(),
          resolvedByKey: new Map(),
          linkedProjects: new Set(),
          applied: [],
          projects: null,
        },
        planned.plan,
      );
      if (!outcome.ok || !shouldCommit) {
        throw new TransactionRollback(outcome);
      }
      return outcome;
    });
  } catch (error) {
    if (error instanceof TransactionRollback) {
      return error.outcome;
    }
    throw error;
  }
}

/**
 * Carries an outcome out of the transaction while rolling it back.
 *
 * Drizzle's own `tx.rollback()` throws a `TransactionRollbackError` that reaches
 * the caller with no payload, so it can say "this was rolled back" but not why —
 * and a refusal has to come back with its issues attached.
 */
class TransactionRollback extends Error {
  constructor(readonly outcome: ChangeSetOutcome) {
    super("change set rolled back");
    this.name = "TransactionRollback";
  }
}

/* ------------------------------------------------------------- the run state */

/** A stored entity, in the shape every stage needs and all three rows provide. */
type StoredEntity = {
  readonly id: string;
  readonly key: string;
  readonly projectId: string;
  readonly revision: number;
  readonly document: Record<string, unknown>;
};

type ResolvedEntity = StoredEntity & { readonly entity: EntityType };

type Execution = {
  readonly tx: DbTransaction;
  readonly scope: WorkspaceScope;
  /** Recorded as `changed_by` on every revision. From the token, never the input. */
  readonly actor: string;
  /** The change set's own reason, recorded as `change_reason` on every revision. */
  readonly reason: string;
  readonly changeSet: ChangeSet;
  /** Consent gates mutation only; validate simulates the operation and rolls it back. */
  readonly enforceConfirmation: boolean;
  /** Temp id → the entity its `create` produced. Filled as creates execute. */
  readonly resolvedByTemp: Map<string, ResolvedEntity>;
  /** Key → the entity it named, so one key costs one lookup per change set. */
  readonly resolvedByKey: Map<string, ResolvedEntity>;
  /** Projects whose dependency graph a `link` touched, for the cycle check. */
  readonly linkedProjects: Set<string>;
  readonly applied: AppliedOperation[];
  /** The workspace's projects, read once. Mutable because it is a lazy cache. */
  projects: readonly Project[] | null;
};

const invalid = (...issues: DocumentIssue[]): Refusal => ({
  ok: false,
  code: "invalid_change_set",
  issues,
});

/** A resolution either produced an entity or produced the reasons it could not. */
type Resolution =
  | { readonly ok: true; readonly value: ResolvedEntity }
  | { readonly ok: false; readonly refusal: Refusal };

async function executePlan(
  run: Execution,
  plan: readonly PlannedOperation[],
): Promise<ChangeSetOutcome> {
  // The fixed first lock for every mutation. Creates and updates need it too:
  // otherwise they can resolve a child in the old project while a concurrent
  // ancestor move bulk-reprojects that child without changing its revision.
  await workspaceRepository.lockForChangeSet(run.scope, run.tx);
  for (const operation of plan) {
    const refusal = await executeOperation(run, operation);
    if (refusal) {
      return refusal;
    }
  }
  // 6. The cycle check, over the graph as it now stands. Only a `link` can add a
  //    `blocked_by` edge, so a change set without one cannot have closed a loop.
  const cycle = await findCycle(run);
  if (cycle) {
    return cycle;
  }
  return { ok: true, applied: run.applied };
}

async function executeOperation(
  run: Execution,
  operation: PlannedOperation,
): Promise<Refusal | null> {
  switch (operation.kind) {
    case "create": {
      return await applyCreate(run, operation);
    }
    case "update": {
      return await applyUpdate(run, operation);
    }
    case "archive":
    case "delete": {
      return await applyRetirement(run, operation);
    }
    case "move": {
      return await applyMove(run, operation);
    }
    case "link":
    case "unlink": {
      return await applyLink(run, operation);
    }
  }
}

/* --------------------------------------------------------- 3. reference resolution */

async function listProjects(run: Execution): Promise<readonly Project[]> {
  run.projects ??= await workspaceRepository.listProjects(run.scope);
  return run.projects;
}

/**
 * The projects one operation's keys may be resolved in.
 *
 * All of them, unless the operation named the requested qualifier — `project` for
 * a target or create parent, `parent_project` for a move's new parent. Read from the
 * **submitted** operation rather than from the plan, the same way `confirm` is: the
 * plan models what an operation does, and which project a key lives in is a fact
 * about the workspace, not part of the operation's meaning.
 *
 * A `project` that names nothing is a refusal in its own right. Silently falling
 * back to a workspace-wide search would turn a typo into a write against a project
 * the caller did not name.
 */
async function candidateProjects(
  run: Execution,
  index: number,
  qualifier: "project" | "parent_project",
): Promise<
  | { readonly ok: true; readonly projects: readonly Project[] }
  | { readonly ok: false; readonly refusal: Refusal }
> {
  const named = run.changeSet.operations[index]?.[qualifier];
  const projects = await listProjects(run);
  if (named === undefined) {
    return { ok: true, projects };
  }
  const match = projects.find((project) => project.name === named || project.id === named);
  if (!match) {
    return {
      ok: false,
      refusal: invalid(
        shapeIssue(
          `operations[${String(index)}].${qualifier}`,
          `No project of this workspace is called ${named}. The projects are: ${projects.map((project) => project.name).join(", ")}.`,
        ),
      ),
    };
  }
  return { ok: true, projects: [match] };
}

/**
 * The entity a `PlanRef` names, as it stands inside this transaction.
 *
 * A temp id is already resolved — the plan guarantees its `create` ran earlier —
 * so it costs nothing. A key costs one lookup per candidate project, because a key
 * is unique *per project*: `STR-12` exists in every project that has twelve
 * streams. The selected qualifier narrows the candidates to one; without it every
 * project is asked, and two answers is a refusal that names the projects and says
 * how to disambiguate rather than guessing.
 */
async function resolveRef(
  run: Execution,
  ref: PlanRef,
  path: string,
  index: number,
  qualifier: "project" | "parent_project" = "project",
): Promise<Resolution> {
  if (ref.kind === "project") {
    return {
      ok: false,
      refusal: invalid(
        shapeIssue(path, `${ref.name} names a project, and a project is not an entity.`),
      ),
    };
  }
  if (ref.kind === "temp") {
    const created = run.resolvedByTemp.get(ref.ref);
    if (!created) {
      // The plan guarantees the create ran first, but a later delete of an
      // existing ancestor may have cascade-deleted that created descendant. It
      // is now an ordinary missing reference, not a server invariant failure.
      return { ok: false, refusal: invalid(ruleIssue("referenced_ids_must_exist", path)) };
    }
    return { ok: true, value: created };
  }

  const candidates = await candidateProjects(run, index, qualifier);
  if (!candidates.ok) {
    return candidates;
  }
  // The cache is keyed by key alone, so it is safe only after a qualifier narrowed
  // this resolution to one project. With several candidates we must query every
  // one even when a cached row matches one of them; otherwise a qualified first
  // operation could make a later bare key silently skip an ambiguity.
  const cached = run.resolvedByKey.get(ref.key);
  if (
    cached &&
    candidates.projects.length === 1 &&
    candidates.projects[0]?.id === cached.projectId
  ) {
    return { ok: true, value: cached };
  }
  const hits: { project: Project; row: ResolvedEntity }[] = [];
  for (const project of candidates.projects) {
    const row = await findByKey(run, ref.entity, project.id, ref.key);
    if (row) {
      hits.push({ project, row: { ...row, entity: ref.entity } });
    }
  }
  const [only, ...rest] = hits;
  if (!only) {
    return { ok: false, refusal: invalid(ruleIssue("referenced_ids_must_exist", path)) };
  }
  if (rest.length > 0) {
    return {
      ok: false,
      refusal: invalid(
        shapeIssue(
          path,
          `${ref.key} exists in ${String(hits.length)} projects of this workspace, so it does not name one entity. Keys are unique per project. Send this operation again with ${qualifier} set to one of: ${hits.map((hit) => hit.project.name).join(", ")}.`,
        ),
      ),
    };
  }
  run.resolvedByKey.set(ref.key, only.row);
  return { ok: true, value: only.row };
}

/** The project a `create`'s parent names, for an epic — the only entity with one. */
async function resolveProject(
  run: Execution,
  ref: PlanRef,
  path: string,
): Promise<{ ok: true; id: string } | { ok: false; refusal: Refusal }> {
  if (ref.kind !== "project") {
    return {
      ok: false,
      refusal: invalid(shapeIssue(path, "An epic's parent is a project, named by its name.")),
    };
  }
  const match = (await listProjects(run)).find((project) => project.name === ref.name);
  if (!match) {
    return { ok: false, refusal: invalid(ruleIssue("referenced_ids_must_exist", path)) };
  }
  return { ok: true, id: match.id };
}

async function findByKey(
  run: Execution,
  entity: EntityType,
  projectId: string,
  key: string,
): Promise<StoredEntity | null> {
  switch (entity) {
    case "epic": {
      return await epicRepository.findByKey(run.scope, { projectId, key }, run.tx);
    }
    case "stream": {
      return await streamRepository.findByKey(run.scope, { projectId, key }, run.tx);
    }
    case "task": {
      return await taskRepository.findByKey(run.scope, { projectId, key }, run.tx);
    }
  }
}

/* ------------------------------------------------------ 4./5. the document */

const SCHEMA_VERSION = {
  epic: EPIC_SCHEMA_VERSION,
  stream: STREAM_SCHEMA_VERSION,
  task: TASK_SCHEMA_VERSION,
} as const satisfies Record<EntityType, string>;

/** Which `links` field records the parent, and therefore what the server fills in. */
const PARENT_LINK = {
  epic: null,
  stream: "parent_epic_id",
  task: "parent_stream_id",
} as const satisfies Record<EntityType, string | null>;

/**
 * Which `content` field the `summary` column denormalises.
 *
 * `summary` is not decoration: together with `title` it *is* the `search_vector`
 * (`generatedAlwaysAs` over both), so an entity whose summary is empty is an
 * entity full-text search cannot find while its document looks perfectly fine.
 * Derived here rather than accepted as an argument, for the same reason the
 * repository derives `title`: a caller able to pass it separately could make the
 * column disagree with the document.
 */
const SUMMARY_FIELD = {
  epic: "purpose",
  stream: "purpose",
  task: "objective",
} as const satisfies Record<EntityType, string>;

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

function summaryOf(entity: EntityType, document: Record<string, unknown>): string | null {
  const value = asRecord(document.content)[SUMMARY_FIELD[entity]];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/**
 * `content.implements.stream_id` is a denormalised parent reference, not a
 * caller-selected relationship. Canonicalise it from the resolved parent on
 * create, update and move so temp ids, keys and stale stream ids cannot survive
 * in a stored task document.
 */
function withTaskImplementationStream(
  document: Record<string, unknown>,
  streamId: string,
): Record<string, unknown> {
  const content = asRecord(document.content);
  const implementation = content.implements;
  if (
    typeof implementation !== "object" ||
    implementation === null ||
    Array.isArray(implementation)
  ) {
    return document;
  }
  return {
    ...document,
    content: {
      ...content,
      implements: { ...(implementation as Record<string, unknown>), stream_id: streamId },
    },
  };
}

/**
 * Builds the document a `create` will store and parses it at the agent tier.
 *
 * The envelope's `entity` and `schema_version` literals are added here because
 * which entity is being created is the operation's decision, not the author's, and
 * the parent link is written from the resolved parent rather than from the input —
 * an agent names the parent once, as `parent`, and cannot make `links` disagree
 * with it. Empty `links` and `provenance` are supplied when absent: both are
 * required containers of optional fields, so demanding `provenance: {}` in the
 * input would be a shape error that teaches nothing.
 */
function buildCreateDocument(
  entity: EntityType,
  data: Record<string, unknown>,
  parentId: string | null,
  path: string,
): { ok: true; document: Record<string, unknown> } | { ok: false; refusal: Refusal } {
  const patched = applySectionPatch({}, data);
  if (!patched.ok) {
    return { ok: false, refusal: prefixed(patched.issues, path) };
  }
  const parentLink = PARENT_LINK[entity];
  const document: Record<string, unknown> = {
    entity,
    schema_version: SCHEMA_VERSION[entity],
    ...patched.document,
    links: {
      ...asRecord(patched.document.links),
      ...(parentLink === null || parentId === null ? {} : { [parentLink]: parentId }),
    },
    provenance: asRecord(patched.document.provenance),
  };
  return {
    ok: true,
    document:
      entity === "task" && parentId !== null
        ? withTaskImplementationStream(document, parentId)
        : document,
  };
}

/**
 * Parses a document, letting `parseDocument` pick both the content schema and the
 * readiness tier.
 *
 * `source` is the only argument, and it says where the document *came from*, not
 * how strict to be: an agent's input is checked against a `meta` that rejects the
 * five server-owned fields, and a document read back out of the table is checked
 * against one that expects them. Neither is a "skip the gates" switch — the tier
 * is `documentTier(entity, meta.status)`, read from the status actually being
 * written.
 */
function parseAt(
  document: Record<string, unknown>,
  source: "agent" | "store",
  path: string,
): { ok: true; document: Record<string, unknown> } | { ok: false; refusal: Refusal } {
  const result = parseDocument(document, { source });
  if (!result.ok) {
    return { ok: false, refusal: prefixed(result.issues, path) };
  }
  return { ok: true, document: result.document };
}

/**
 * The ids in a task's `content.implements` have to exist in the stream the task
 * hangs from (domain spec §11 `referenced_ids_must_exist`).
 *
 * This is the one rule no single-document schema can carry, and the reason it is
 * worth carrying: a task that implements `FR-009` when the stream has no `FR-009`
 * is a task nobody can trace back to a business requirement, which is exactly the
 * §14 failure the `implements` section exists to prevent.
 */
function implementedIdIssues(
  document: Record<string, unknown>,
  parentDocument: Record<string, unknown>,
  path: string,
): readonly DocumentIssue[] {
  const section = asRecord(asRecord(document.content).implements);
  const known = {
    requirement_ids: new Set(
      [
        ...idsOf(asRecord(asRecord(parentDocument.content).requirements).functional),
        ...idsOf(asRecord(asRecord(parentDocument.content).requirements).non_functional),
      ].filter((id): id is string => id !== null),
    ),
    acceptance_criteria_ids: new Set(
      idsOf(asRecord(parentDocument.content).acceptance_criteria).filter(
        (id): id is string => id !== null,
      ),
    ),
  } as const;
  const issues: DocumentIssue[] = [];
  for (const field of ["requirement_ids", "acceptance_criteria_ids"] as const) {
    const ids = section[field];
    if (!Array.isArray(ids)) {
      continue;
    }
    ids.forEach((id, position) => {
      if (typeof id === "string" && !known[field].has(id)) {
        issues.push(
          ruleIssue(
            "referenced_ids_must_exist",
            `${path}.content.implements.${field}[${String(position)}]`,
          ),
        );
      }
    });
  }
  return issues;
}

const idsOf = (value: unknown): readonly (string | null)[] =>
  Array.isArray(value)
    ? value.map((element) => {
        const id: unknown = asRecord(element).id;
        return typeof id === "string" ? id : null;
      })
    : [];

/** The parent stream of a task, needed to check what the task says it implements. */
async function parentStreamDocument(
  run: Execution,
  document: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const parentId: unknown = asRecord(document.links).parent_stream_id;
  if (typeof parentId !== "string") {
    return null;
  }
  const row = await streamRepository.findById(run.scope, parentId, run.tx);
  return row?.document ?? null;
}

/* ------------------------------------------------------- 7. the confirm gate */

const DESTRUCTIVE_REMEDIATION =
  "Nothing was written. Show the user exactly which entity this affects and what it " +
  "will cost them, get their explicit approval, then send the same change set again " +
  "with confirm: true on that operation.";

/**
 * Refuses a destructive operation the user has not approved.
 *
 * Read from the *submitted* operation rather than from the plan, because the plan
 * models what an operation does and consent is not part of that. Per operation and
 * not per call: `apply_change_set` is always a destructive tool, so a per-call flag
 * would be demanded even by a change set that only creates, an agent would learn to
 * send it every time, and the gate would stop meaning anything.
 *
 * There is no role-based gating in the MVP — `confirm: true` is the only gate on a
 * destructive operation, which is why it is not allowed to become reflexive.
 */
function confirmationRefusal(
  run: Execution,
  operation: Extract<PlannedOperation, { kind: "archive" | "delete" | "move" }>,
): Refusal | null {
  if (!run.enforceConfirmation || run.changeSet.operations[operation.index]?.confirm === true) {
    return null;
  }
  return {
    ok: false,
    code: "destructive_requires_confirm",
    index: operation.index,
    operation: operation.kind,
    key: operation.target.key,
    message: `${operation.kind} of ${operation.target.key} needs confirm: true. ${DESTRUCTIVE_REMEDIATION}`,
  };
}

/* -------------------------------------------------------------- 8. the writes */

async function applyCreate(
  run: Execution,
  operation: Extract<PlannedOperation, { kind: "create" }>,
): Promise<Refusal | null> {
  const path = `operations[${String(operation.index)}].data`;
  const parentPath = `operations[${String(operation.index)}].parent`;

  let projectId: string;
  let parentId: string | null = null;
  if (operation.entity === "epic") {
    const project = await resolveProject(run, operation.parent, parentPath);
    if (!project.ok) {
      return project.refusal;
    }
    projectId = project.id;
  } else {
    const parent = await resolveRef(run, operation.parent, parentPath, operation.index);
    if (!parent.ok) {
      return parent.refusal;
    }
    projectId = parent.value.projectId;
    parentId = parent.value.id;
  }

  const built = buildCreateDocument(operation.entity, operation.data, parentId, path);
  if (!built.ok) {
    return built.refusal;
  }
  const parsedDocument = parseAt(built.document, "agent", path);
  if (!parsedDocument.ok) {
    return parsedDocument.refusal;
  }
  const document = parsedDocument.document;

  if (operation.entity === "task") {
    const parent = await parentStreamDocument(run, document);
    const issues = parent === null ? [] : implementedIdIssues(document, parent, path);
    if (issues.length > 0) {
      return invalid(...issues);
    }
  }

  const written = await insertEntity(run, operation.entity, projectId, parentId, document);
  if (!written.ok) {
    // An insert has no `expected_revision`, so the only failure it can report is
    // `not_found`, and the only thing it could not find is the parent — the row
    // being written does not exist yet.
    return invalid(ruleIssue("referenced_ids_must_exist", parentPath));
  }
  const created: ResolvedEntity = { ...written.row, entity: operation.entity };
  if (operation.ref !== null) {
    run.resolvedByTemp.set(operation.ref, created);
  }
  run.resolvedByKey.set(created.key, created);
  record(run, operation.index, "create", created, operation.ref);
  return null;
}

async function insertEntity(
  run: Execution,
  entity: EntityType,
  projectId: string,
  parentId: string | null,
  document: Record<string, unknown>,
): Promise<WriteResult<StoredEntity>> {
  const common = {
    projectId,
    document,
    summary: summaryOf(entity, document),
    changedBy: run.actor,
    changeReason: run.reason,
  };
  switch (entity) {
    case "epic": {
      return await epicRepository.insert(run.scope, common, run.tx);
    }
    case "stream": {
      return await streamRepository.insert(
        run.scope,
        { ...common, epicId: requireParent(parentId, "stream") },
        run.tx,
      );
    }
    case "task": {
      return await taskRepository.insert(
        run.scope,
        { ...common, streamId: requireParent(parentId, "task") },
        run.tx,
      );
    }
  }
}

/** Unreachable: `planChangeSet` requires a parent for a stream and a task. */
function requireParent(parentId: string | null, entity: EntityType): string {
  if (parentId === null) {
    throw new DomainError("parent_unresolved", `A ${entity} reached the insert with no parent.`);
  }
  return parentId;
}

async function applyUpdate(
  run: Execution,
  operation: Extract<PlannedOperation, { kind: "update" }>,
): Promise<Refusal | null> {
  const path = `operations[${String(operation.index)}].data`;
  const target = await resolveRef(
    run,
    operation.target,
    `operations[${String(operation.index)}].key`,
    operation.index,
  );
  if (!target.ok) {
    return target.refusal;
  }

  if (Object.hasOwn(operation.data, "links")) {
    return invalid(
      shapeIssue(
        `${path}.links`,
        "Document links are server-controlled. Use link or unlink for relationships, and move to change a parent.",
      ),
    );
  }

  // Section-level replace, not an array deep-merge: what an author sent is what
  // that section now says. `patch.ts` carries the argument.
  const patched = applySectionPatch(target.value.document, operation.data);
  if (!patched.ok) {
    return prefixed(patched.issues, path);
  }
  // The store tier, because the merged document carries the `meta` the server
  // stamped on it. The five server-owned fields are re-stamped by the repository
  // afterwards, so a patch that names one is overwritten rather than honoured.
  const parentStreamId =
    target.value.entity === "task"
      ? asRecord(target.value.document.links).parent_stream_id
      : undefined;
  const candidate =
    target.value.entity === "task" && typeof parentStreamId === "string"
      ? withTaskImplementationStream(patched.document, parentStreamId)
      : patched.document;
  const parsedDocument = parseAt(candidate, "store", path);
  if (!parsedDocument.ok) {
    return parsedDocument.refusal;
  }
  const document = parsedDocument.document;

  if (target.value.entity === "task") {
    const parent = await parentStreamDocument(run, document);
    const issues = parent === null ? [] : implementedIdIssues(document, parent, path);
    if (issues.length > 0) {
      return invalid(...issues);
    }
  }

  const written = await bumpEntity(run, target.value, operation.expectedRevision, document);
  if (!written.ok) {
    return writeRefusal(written, target.value, operation.index, operation.expectedRevision);
  }
  refresh(run, target.value, written.row);
  record(run, operation.index, "update", { ...written.row, entity: target.value.entity }, null);
  return null;
}

async function bumpEntity(
  run: Execution,
  target: ResolvedEntity,
  expectedRevision: number,
  document: Record<string, unknown>,
): Promise<WriteResult<StoredEntity>> {
  const common = {
    id: target.id,
    expectedRevision,
    document,
    summary: summaryOf(target.entity, document),
    changedBy: run.actor,
    changeReason: run.reason,
  };
  switch (target.entity) {
    case "epic": {
      return await epicRepository.bumpRevision(run.scope, common, run.tx);
    }
    case "stream": {
      return await streamRepository.bumpRevision(run.scope, common, run.tx);
    }
    case "task": {
      return await taskRepository.bumpRevision(run.scope, common, run.tx);
    }
  }
}

async function applyRetirement(
  run: Execution,
  operation: Extract<PlannedOperation, { kind: "archive" | "delete" }>,
): Promise<Refusal | null> {
  const target = await resolveRef(
    run,
    operation.target,
    `operations[${String(operation.index)}].key`,
    operation.index,
  );
  if (!target.ok) {
    return target.refusal;
  }
  const unconfirmed = confirmationRefusal(run, operation);
  if (unconfirmed) {
    return unconfirmed;
  }

  // Read before the write, because a delete cascades: the streams and tasks under a
  // deleted epic are gone by the time the delete returns, and their `entity_link`
  // rows are not — the endpoints are polymorphic, so no foreign key cascades them.
  // Enumerating the subtree afterwards would find nothing and leave every
  // descendant's edges dangling, which is the same orphan-edge bug one level down.
  const subtree =
    operation.kind === "delete"
      ? await listDescendants(run.scope, run.tx, {
          type: target.value.entity,
          id: target.value.id,
        })
      : [];

  const written =
    operation.kind === "archive"
      ? await archiveEntity(run, target.value, operation.expectedRevision)
      : await deleteEntity(run, target.value, operation.expectedRevision);
  if (!written.ok) {
    return writeRefusal(written, target.value, operation.index, operation.expectedRevision);
  }
  if (operation.kind === "delete") {
    // The deleted entity and everything the cascade took with it. A leftover
    // `blocked_by` edge is one the cycle check would still walk through, reporting
    // a cycle through an entity nobody can look up.
    for (const endpoint of [{ type: target.value.entity, id: target.value.id }, ...subtree]) {
      await entityLinkRepository.unlinkAll(run.scope, endpoint, run.tx);
    }
    evictDeletedSubtree(run, [{ type: target.value.entity, id: target.value.id }, ...subtree]);
  } else {
    refresh(run, target.value, written.row);
  }
  record(
    run,
    operation.index,
    operation.kind,
    { ...written.row, entity: target.value.entity },
    null,
  );
  return null;
}

/** Removes every cache entry a cascading delete took with its root. */
function evictDeletedSubtree(
  run: Execution,
  endpoints: readonly { readonly type: EntityType; readonly id: string }[],
): void {
  const deleted = new Set(endpoints.map(({ type, id }) => `${type}:${id}`));
  const wasDeleted = (entity: ResolvedEntity) => deleted.has(`${entity.entity}:${entity.id}`);
  for (const [key, entity] of run.resolvedByKey) {
    if (wasDeleted(entity)) {
      run.resolvedByKey.delete(key);
    }
  }
  for (const [ref, entity] of run.resolvedByTemp) {
    if (wasDeleted(entity)) {
      run.resolvedByTemp.delete(ref);
    }
  }
}

async function archiveEntity(
  run: Execution,
  target: ResolvedEntity,
  expectedRevision: number,
): Promise<WriteResult<StoredEntity>> {
  const common = {
    id: target.id,
    expectedRevision,
    changedBy: run.actor,
    changeReason: run.reason,
  };
  switch (target.entity) {
    case "epic": {
      return await epicRepository.archive(run.scope, common, run.tx);
    }
    case "stream": {
      return await streamRepository.archive(run.scope, common, run.tx);
    }
    case "task": {
      return await taskRepository.archive(run.scope, common, run.tx);
    }
  }
}

async function deleteEntity(
  run: Execution,
  target: ResolvedEntity,
  expectedRevision: number,
): Promise<WriteResult<StoredEntity>> {
  const common = { id: target.id, expectedRevision };
  switch (target.entity) {
    case "epic": {
      return await epicRepository.delete(run.scope, common, run.tx);
    }
    case "stream": {
      return await streamRepository.delete(run.scope, common, run.tx);
    }
    case "task": {
      return await taskRepository.delete(run.scope, common, run.tx);
    }
  }
}

async function applyMove(
  run: Execution,
  operation: Extract<PlannedOperation, { kind: "move" }>,
): Promise<Refusal | null> {
  const keyPath = `operations[${String(operation.index)}].key`;
  const parentPath = `operations[${String(operation.index)}].parent`;
  const target = await resolveRef(run, operation.target, keyPath, operation.index);
  if (!target.ok) {
    return target.refusal;
  }

  let written: WriteResult<StoredEntity>;
  if (target.value.entity === "epic") {
    const project = await resolveProject(run, operation.parent, parentPath);
    if (!project.ok) {
      return project.refusal;
    }
    const unconfirmed = confirmationRefusal(run, operation);
    if (unconfirmed) {
      return unconfirmed;
    }
    const linkRefusal = await prepareCrossProjectMove(run, target.value, project.id, parentPath);
    if (linkRefusal) {
      return linkRefusal;
    }
    written = await epicRepository.move(
      run.scope,
      {
        id: target.value.id,
        expectedRevision: operation.expectedRevision,
        projectId: project.id,
        changedBy: run.actor,
        changeReason: run.reason,
      },
      run.tx,
    );
  } else {
    const parent = await resolveRef(
      run,
      operation.parent,
      parentPath,
      operation.index,
      "parent_project",
    );
    if (!parent.ok) {
      return parent.refusal;
    }
    const unconfirmed = confirmationRefusal(run, operation);
    if (unconfirmed) {
      return unconfirmed;
    }
    const linkRefusal = await prepareCrossProjectMove(
      run,
      target.value,
      parent.value.projectId,
      parentPath,
    );
    if (linkRefusal) {
      return linkRefusal;
    }
    const common = {
      id: target.value.id,
      expectedRevision: operation.expectedRevision,
      changedBy: run.actor,
      changeReason: run.reason,
    };
    let taskDocument: Record<string, unknown> | undefined;
    if (target.value.entity === "task") {
      taskDocument = withTaskImplementationStream(target.value.document, parent.value.id);
      const parsed = parseAt(taskDocument, "store", `operations[${String(operation.index)}]`);
      if (!parsed.ok) {
        return parsed.refusal;
      }
      taskDocument = parsed.document;
      const issues = implementedIdIssues(
        taskDocument,
        parent.value.document,
        `operations[${String(operation.index)}]`,
      );
      if (issues.length > 0) {
        return invalid(...issues);
      }
    }
    written =
      target.value.entity === "stream"
        ? await streamRepository.move(run.scope, { ...common, epicId: parent.value.id }, run.tx)
        : await taskRepository.move(
            run.scope,
            { ...common, streamId: parent.value.id, document: taskDocument },
            run.tx,
          );
  }

  if (!written.ok) {
    return writeRefusal(written, target.value, operation.index, operation.expectedRevision);
  }
  if (written.row.projectId !== target.value.projectId) {
    // The moved subtree brought keys the target project's counters have never
    // issued, so its next create would hand out a key that is already taken.
    await raiseKeyCounters(run.scope, run.tx, written.row.projectId);
    // Existing dependency edges that moved with the subtree now belong to the
    // destination graph. Check both sides: links added earlier in this same set
    // may have marked only the source before being reprojected above.
    run.linkedProjects.add(target.value.projectId);
    run.linkedProjects.add(written.row.projectId);
    // An ancestor move rewrites descendants in bulk. Both caches may therefore
    // carry a correct id with a stale project/document; reload them before a
    // later qualified lookup, temp-parent create or link can consume that state.
    await refreshResolutionCaches(run);
  } else {
    refresh(run, target.value, written.row);
  }
  record(run, operation.index, "move", { ...written.row, entity: target.value.entity }, null);
  return null;
}

/**
 * Reprojects links wholly contained in a cross-project move and refuses a move
 * that would strand either endpoint in the old project.
 *
 * The repository move changes the whole entity subtree, so relationship
 * handling must use that same subtree rather than only the explicit target.
 * Running before the entity write is safe because every caller is already in
 * the change-set transaction: any later refusal rolls both parts back.
 */
async function prepareCrossProjectMove(
  run: Execution,
  target: ResolvedEntity,
  targetProjectId: string,
  path: string,
): Promise<Refusal | null> {
  if (target.projectId === targetProjectId) {
    return null;
  }
  const descendants = await listDescendants(run.scope, run.tx, {
    type: target.entity,
    id: target.id,
  });
  const links = await entityLinkRepository.moveSubtreeLinks(
    run.scope,
    [{ type: target.entity, id: target.id }, ...descendants],
    targetProjectId,
    run.tx,
  );
  if (links.ok) {
    return null;
  }
  return invalid(
    shapeIssue(
      path,
      `This subtree has an existing ${links.boundary.relationshipType} relationship to an entity that is not moving with it. A relationship cannot cross projects. Unlink that boundary relationship in an earlier operation, then move the subtree.`,
    ),
  );
}

async function applyLink(
  run: Execution,
  operation: Extract<PlannedOperation, { kind: "link" | "unlink" }>,
): Promise<Refusal | null> {
  const source = await resolveRef(
    run,
    operation.source,
    `operations[${String(operation.index)}].source`,
    operation.index,
  );
  if (!source.ok) {
    return source.refusal;
  }
  const target = await resolveRef(
    run,
    operation.target,
    `operations[${String(operation.index)}].target`,
    operation.index,
  );
  if (!target.ok) {
    return target.refusal;
  }
  if (source.value.projectId !== target.value.projectId) {
    return invalid(
      shapeIssue(
        `operations[${String(operation.index)}].target`,
        `${source.value.key} and ${target.value.key} are in different projects, and a relationship does not cross a project.`,
      ),
    );
  }

  const endpoints = {
    projectId: source.value.projectId,
    source: { type: source.value.entity, id: source.value.id },
    target: { type: target.value.entity, id: target.value.id },
    relationship: operation.relationship,
  };
  if (operation.kind === "link") {
    // The change set's own reason is the only account of why this dependency was
    // declared; `link` never overwrites a reason that is already recorded, so a
    // re-run cannot replace a deliberate one with a generic one.
    await entityLinkRepository.link(run.scope, { ...endpoints, reason: run.reason }, run.tx);
    run.linkedProjects.add(source.value.projectId);
  } else {
    // A `false` here means there was nothing to remove, which is the same answer
    // `link` gives for a relationship that already exists: the requested state
    // holds. Failing would make re-running a change set destructive.
    await entityLinkRepository.unlink(run.scope, endpoints, run.tx);
  }
  run.applied.push({
    index: operation.index,
    operation: operation.kind,
    entity: null,
    key: null,
    id: null,
    revision: null,
    ref: null,
  });
  return null;
}

/* ------------------------------------------------------------ 6. the cycle check */

/**
 * Refuses a change set that closed a dependency loop.
 *
 * Run over the graph as the transaction now sees it, rather than over a
 * prediction of it: the edges just written are visible inside the transaction, so
 * the check reads what would actually be committed, and a cycle rolls the whole
 * set back. Only `blocked_by` claims an order, so only `blocked_by` can be
 * unsatisfiable in a loop — `edgesForProject` filters it, and nothing here can
 * widen that.
 */
async function findCycle(run: Execution): Promise<Refusal | null> {
  for (const projectId of run.linkedProjects) {
    const edges = await entityLinkRepository.edgesForProject(run.scope, projectId, run.tx);
    const cycle = findDependencyCycle(edges);
    if (!cycle) {
      continue;
    }
    const types = new Map<string, EntityType>();
    for (const edge of edges) {
      types.set(edge.from, edge.fromType);
      types.set(edge.to, edge.toType);
    }
    const named: string[] = [];
    for (const node of cycle) {
      const type = types.get(node);
      const row = type === undefined ? null : await findById(run, type, node);
      named.push(row?.key ?? node);
    }
    return invalid(
      shapeIssue(
        "operations",
        `${named.join(" is blocked by ")} — a dependency cannot be circular. Remove one of those links.`,
      ),
      ruleIssue("dependencies_must_be_acyclic", "operations"),
    );
  }
  return null;
}

async function findById(
  run: Execution,
  entity: EntityType,
  id: string,
): Promise<StoredEntity | null> {
  switch (entity) {
    case "epic": {
      return await epicRepository.findById(run.scope, id, run.tx);
    }
    case "stream": {
      return await streamRepository.findById(run.scope, id, run.tx);
    }
    case "task": {
      return await taskRepository.findById(run.scope, id, run.tx);
    }
  }
}

/* ------------------------------------------------------------------ plumbing */

/**
 * What a failed write means to the agent.
 *
 * `revision_conflict` carries the entity as it stands now, because the agent that
 * lost the race has to see what it collided with before it can merge and retry —
 * a bare "conflict" costs it another round trip to find out what changed. It also
 * carries the revision it *thought* it had, so the two numbers are visible
 * together. `not_found` is folded into `referenced_ids_must_exist`: between the
 * lookup and the write, the entity stopped existing.
 */
function writeRefusal(
  written: Extract<WriteResult<StoredEntity>, { ok: false }>,
  target: ResolvedEntity,
  index: number,
  expectedRevision: number,
): Refusal {
  if (written.reason === "not_found") {
    return invalid(ruleIssue("referenced_ids_must_exist", `operations[${String(index)}].key`));
  }
  const key = target.key;
  return {
    ok: false,
    code: "revision_conflict",
    index,
    key,
    expectedRevision,
    current: {
      entity: target.entity,
      id: written.current.id,
      key: written.current.key,
      revision: written.current.revision,
      document: written.current.document,
    },
    message: `${key} is at revision ${String(written.current.revision)}, not ${String(expectedRevision)}. Someone else wrote it first, so nothing in this change set was applied. Re-read it, merge your change into the current document and send the change set again.`,
  };
}

/** Keeps the key cache pointing at the row as it stands after a write. */
function refresh(run: Execution, target: ResolvedEntity, row: StoredEntity): void {
  const refreshed: ResolvedEntity = { ...row, entity: target.entity };
  // A created entity is addressable through both its temp ref and its issued
  // real key later in the same set. Updating through either alias must refresh
  // every alias; otherwise a later temp-parent create validates against the
  // pre-update document/revision while a key lookup sees the new one.
  const sameIdentity = (entity: ResolvedEntity) =>
    entity.entity === target.entity && entity.id === target.id;
  for (const [key, entity] of run.resolvedByKey) {
    if (sameIdentity(entity)) {
      run.resolvedByKey.set(key, refreshed);
    }
  }
  for (const [ref, entity] of run.resolvedByTemp) {
    if (sameIdentity(entity)) {
      run.resolvedByTemp.set(ref, refreshed);
    }
  }
  run.resolvedByKey.set(target.key, refreshed);
}

/**
 * Reloads every resolved entity after a bulk subtree re-projection.
 *
 * A move of an epic or stream changes descendant rows without visiting them one
 * by one in this service. Key refs and temp refs are both allowed later in the
 * same atomic set, so retaining either old value would let the old project
 * qualifier through or create a child/link with mismatched project ownership.
 */
async function refreshResolutionCaches(run: Execution): Promise<void> {
  const loaded = new Map<string, ResolvedEntity>();
  const current = async (cached: ResolvedEntity): Promise<ResolvedEntity> => {
    const identity = `${cached.entity}:${cached.id}`;
    const already = loaded.get(identity);
    if (already) {
      return already;
    }
    const row = await findById(run, cached.entity, cached.id);
    if (!row) {
      throw new DomainError(
        "resolved_entity_disappeared",
        `${cached.key} disappeared while refreshing the resolution cache after a move.`,
      );
    }
    const refreshed = { ...row, entity: cached.entity };
    loaded.set(identity, refreshed);
    return refreshed;
  };

  for (const [key, cached] of run.resolvedByKey) {
    run.resolvedByKey.set(key, await current(cached));
  }
  for (const [ref, cached] of run.resolvedByTemp) {
    run.resolvedByTemp.set(ref, await current(cached));
  }
}

function record(
  run: Execution,
  index: number,
  operation: ChangeSetOperationKind,
  entity: ResolvedEntity,
  ref: string | null,
): void {
  run.applied.push({
    index,
    operation,
    entity: entity.entity,
    key: entity.key,
    id: entity.id,
    revision: entity.revision,
    ref,
  });
}

/**
 * Re-roots a document-level issue path under the operation that produced it, so
 * `content.purpose` becomes `operations[2].data.content.purpose` and an agent is
 * told which of fifty operations to fix.
 */
function prefixed(issues: readonly DocumentIssue[], path: string): Refusal {
  return {
    ok: false,
    code: "invalid_change_set",
    issues: issues.map((issue) => ({
      ...issue,
      path: issue.path.length === 0 ? path : `${path}.${issue.path}`,
    })),
  };
}

/**
 * Turns the change-set schema's own failures into the one issue shape.
 *
 * An unrecognised key becomes the §14 "no invented fields" rule rather than a
 * shape message, because that is what it is — the flat operation object exists to
 * keep the generated schema small, and an agent that invents a field on it has
 * made the same mistake as one that invents a document section. The same mapping
 * `schema/document.ts` makes for a document, so `validate_change_set` reports one
 * rule id whichever layer noticed.
 */
function zodIssues(issues: readonly z.core.$ZodIssue[]): readonly DocumentIssue[] {
  return issues.flatMap((issue) => {
    const path = formatPath(issue.path);
    if (issue.code === "unrecognized_keys") {
      return issue.keys.map((key) =>
        ruleIssue("no_invented_fields", path.length === 0 ? key : `${path}.${key}`),
      );
    }
    return [shapeIssue(path, issue.message)];
  });
}

const formatPath = (segments: readonly PropertyKey[]): string =>
  segments.reduce<string>(
    (path, segment) =>
      typeof segment === "number"
        ? `${path}[${String(segment)}]`
        : path.length === 0
          ? String(segment)
          : `${path}.${String(segment)}`,
    "",
  );
