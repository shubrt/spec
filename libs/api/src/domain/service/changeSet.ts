import type { z } from "zod";
import { DomainError } from "../../_/errors";
import { db } from "../../integration/drizzle/client";
import type { WorkspaceAuthContext } from "../auth/authContext";
import type { WorkspaceScope } from "../auth/workspaceScope";
import { diffDocuments, entityDiff, type SemanticDiff } from "../changeSet/diff";
import { ITEM_COLLECTION_PATHS, applyItemMutations, applySectionPatch } from "../changeSet/patch";
import { type PlanRef, type PlannedOperation, planChangeSet } from "../changeSet/plan";
import { type ChangeSet, type ChangeSetOperationKind, changeSetSchema } from "../changeSet/schema";
import {
  DEPENDENCY_ENDPOINT_TYPE,
  HIERARCHY_ENTITY_TYPE,
  LINKABLE_ENTITY_TYPE,
  TASK_STATUS,
  type HierarchyEntityType,
  type LinkableEntityType,
  type VersionedEntityType,
} from "../enums";
import { findDependencyCycle } from "../graph/cycle";
import {
  type DbTransaction,
  type WriteResult,
  findHierarchyKeyCollisions,
  findRevisionDocument,
  listDescendants,
  raiseKeyCounters,
} from "../repository/entity";
import { entityLinkRepository } from "../repository/entityLink";
import { epicRepository } from "../repository/epic";
import { milestoneRepository } from "../repository/milestone";
import { ruleRepository } from "../repository/rule";
import { streamRepository } from "../repository/stream";
import { taskRepository } from "../repository/task";
import { type Project, workspaceRepository } from "../repository/workspace";
import {
  EPIC_SCHEMA_VERSION,
  MILESTONE_SCHEMA_VERSION,
  RULE_SCHEMA_VERSION,
  STREAM_SCHEMA_VERSION,
  TASK_SCHEMA_VERSION,
  parseDocument,
} from "../schema/document";
import { STORED_ONLY_META_KEYS, provenanceSource } from "../schema/envelope";
import { type DocumentIssue, ruleIssue, shapeIssue } from "../schema/rules";
import { PRE_V2_TRACE_NOT_RECORDED } from "../schema/task/content";

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
 * 1. schema parse · 2. temp-id plan · 3. independent document preflight ·
 * 4. reference resolution · 5. canonical document parse and readiness ·
 * 6. cycle check · 7. the apply-only `confirm` gate · 8. the write, under OCC.
 *
 * The preflight deliberately parses creates twice. Its placeholder parent is used
 * only for rules that are independent of database state, which lets two malformed
 * documents report both errors in one response. The ordered simulation remains
 * authoritative for real parents, temp ids, cross-document references, OCC and
 * cycles; those cannot be truthfully evaluated out of order. Nothing is observable
 * before the commit decision either way: a refusal rolls the transaction back, so
 * "nothing was written" holds for all stages.
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
  readonly entity: VersionedEntityType | null;
  readonly key: string | null;
  readonly id: string | null;
  /** The revision the entity now stands at, or `null` where nothing was versioned. */
  readonly revision: number | null;
  /** The temp id a `create` declared, so an agent can match it to the issued key. */
  readonly ref: string | null;
  /** Canonical before/after effects, shared by validate and apply. */
  readonly diff: readonly SemanticDiff[];
};

/** The entity as it stands now, handed back when a write lost the race for it. */
export type ConflictingEntity = {
  readonly entity: VersionedEntityType;
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

  // 3. Collect every error that can be known without reading mutable state.
  //    Both modes call this exact pass, so apply cannot accept a proposal that
  //    validate rejected. Stateful and dependent checks remain in simulation.
  const preflightIssues = independentPreflightIssues(planned.plan);
  if (preflightIssues.length > 0) {
    return { ok: false, code: "invalid_change_set", issues: preflightIssues };
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

const PREFLIGHT_PARENT_ID = "00000000-0000-4000-8000-000000000000";

/** Update fields whose ownership is knowable from the submitted key alone. */
function updateProtocolIssues(
  operation: Extract<PlannedOperation, { kind: "update" }>,
): readonly DocumentIssue[] {
  if (operation.data === null) return [];

  const path = `operations[${String(operation.index)}].data`;
  const issues: DocumentIssue[] = [];
  if (Object.hasOwn(operation.data, "links")) {
    issues.push(
      shapeIssue(
        `${path}.links`,
        "Document links are server-controlled. Use link or unlink for relationships, and move to change a parent.",
      ),
    );
  }

  const executionPatch = operation.data.execution;
  if (
    operation.target.entity === "task" &&
    typeof executionPatch === "object" &&
    executionPatch !== null &&
    !Array.isArray(executionPatch)
  ) {
    for (const field of [
      "trace_state",
      "stream_revision_started",
      "stream_revision_used",
      "rule_revisions_used",
    ]) {
      if (Object.hasOwn(executionPatch, field)) {
        issues.push(ruleIssue("server_owned_meta_is_not_writable", `${path}.execution.${field}`));
      }
    }
  }

  const metaPatch = asRecord(operation.data.meta);
  const schedulingFields = new Set<string>();
  if (operation.target.entity === "milestone" && Object.hasOwn(metaPatch, "roadmap_order")) {
    schedulingFields.add("roadmap_order");
    issues.push(
      shapeIssue(
        `${path}.meta.roadmap_order`,
        "Milestone order is server-controlled. Use schedule to change it.",
      ),
    );
  }
  if (operation.target.entity === "stream") {
    const submittedPlacement = ["milestone_key", "roadmap_rank"].filter((field) =>
      Object.hasOwn(metaPatch, field),
    );
    if (submittedPlacement.length > 0) {
      submittedPlacement.forEach((field) => schedulingFields.add(field));
      issues.push(
        shapeIssue(
          `${path}.meta`,
          "Milestone placement is server-controlled. Use schedule to assign, reorder, or unschedule this Stream.",
        ),
      );
    }
  }
  for (const field of STORED_ONLY_META_KEYS) {
    if (Object.hasOwn(metaPatch, field) && !schedulingFields.has(field)) {
      issues.push(ruleIssue("server_owned_meta_is_not_writable", `${path}.meta.${field}`));
    }
  }

  return issues;
}

/**
 * Checks only facts that cannot change between validation and apply.
 *
 * A failed parent create may poison a later temp-id operation; this pass therefore
 * never pretends to resolve references. It validates each create's own document
 * shape/readiness and each update's standalone patch protocol, then leaves the
 * canonical transaction to evaluate everything that depends on stored state.
 */
function independentPreflightIssues(plan: readonly PlannedOperation[]): readonly DocumentIssue[] {
  const found: { readonly index: number; readonly issue: DocumentIssue }[] = [];
  const add = (index: number, issues: readonly DocumentIssue[]): void => {
    found.push(...issues.map((issue) => ({ index, issue })));
  };

  for (const operation of [...plan].sort((left, right) => left.index - right.index)) {
    const path = `operations[${String(operation.index)}].data`;
    if (operation.kind === "create") {
      const built = buildCreateDocument(
        operation.entity,
        operation.data,
        operation.entity === "epic" ? null : PREFLIGHT_PARENT_ID,
        path,
      );
      if (!built.ok) {
        if (built.refusal.code === "invalid_change_set") {
          add(operation.index, built.refusal.issues);
        }
        continue;
      }
      const parsed = parseAt(built.document, "agent", path);
      if (!parsed.ok && parsed.refusal.code === "invalid_change_set") {
        add(operation.index, parsed.refusal.issues);
      }
      continue;
    }

    if (operation.kind !== "update") {
      continue;
    }
    add(operation.index, updateProtocolIssues(operation));
    if (operation.data !== null) {
      const patched = applySectionPatch({}, operation.data);
      if (!patched.ok) {
        add(
          operation.index,
          patched.issues.map((issue) => ({
            ...issue,
            path: issue.path.length === 0 ? path : `${path}.${issue.path}`,
          })),
        );
      }
    }
    operation.items.forEach((item, itemIndex) => {
      if (!(ITEM_COLLECTION_PATHS as readonly string[]).includes(item.path)) {
        add(operation.index, [
          shapeIssue(
            `operations[${String(operation.index)}].items[${String(itemIndex)}].path`,
            `${item.path} is not an addressable id collection. Allowed paths: ${ITEM_COLLECTION_PATHS.join(", ")}.`,
          ),
        ]);
      }
    });
  }

  // A dependent operation is not validated against invented placeholder state.
  // Name the exact failed declaration instead of emitting a cascade of false
  // missing-reference or readiness errors.
  const failedIndexes = new Set(found.map(({ index }) => index));
  const failedTemp = new Map<string, number>();
  for (const operation of plan) {
    if (
      operation.kind === "create" &&
      operation.ref !== null &&
      failedIndexes.has(operation.index)
    ) {
      failedTemp.set(operation.ref, operation.index);
    }
  }
  let propagated = true;
  while (propagated) {
    propagated = false;
    for (const operation of [...plan].sort((left, right) => left.index - right.index)) {
      if (failedIndexes.has(operation.index)) continue;
      const dependency = tempDependencies(operation)
        .map((ref) => failedTemp.get(ref))
        .find((index): index is number => index !== undefined);
      if (dependency === undefined) continue;
      found.push({
        index: operation.index,
        issue: shapeIssue(
          `operations[${String(operation.index)}]`,
          `not_evaluated: depends on operations[${String(dependency)}], which has independent validation issues.`,
        ),
      });
      failedIndexes.add(operation.index);
      if (operation.kind === "create" && operation.ref !== null) {
        failedTemp.set(operation.ref, operation.index);
      }
      propagated = true;
    }
  }

  return found
    .sort(
      (left, right) => left.index - right.index || left.issue.path.localeCompare(right.issue.path),
    )
    .map(({ issue }) => issue);
}

function tempDependencies(operation: PlannedOperation): readonly string[] {
  const ref = (candidate: PlanRef): readonly string[] =>
    candidate.kind === "temp" ? [candidate.ref] : [];
  switch (operation.kind) {
    case "create": {
      return [...ref(operation.parent), ...embeddedRuleTempDependencies(operation.data)];
    }
    case "move": {
      return ref(operation.parent);
    }
    case "link":
    case "unlink": {
      return [...ref(operation.source), ...ref(operation.target)];
    }
    case "schedule": {
      return [
        ...ref(operation.target),
        ...(operation.milestone === null ? [] : ref(operation.milestone)),
      ];
    }
    case "update": {
      return [
        ...(operation.data === null ? [] : embeddedRuleTempDependencies(operation.data)),
        ...operation.items.flatMap((item) => embeddedRuleTempDependencies(item.value)),
      ];
    }
    case "archive":
    case "delete": {
      return [];
    }
  }
}

function embeddedRuleTempDependencies(value: unknown): readonly string[] {
  if (Array.isArray(value)) return value.flatMap(embeddedRuleTempDependencies);
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => {
    if (key !== "rule_key" && key !== "rule_keys" && key !== "constrained_by_rule_keys") {
      return embeddedRuleTempDependencies(child);
    }
    if (typeof child === "string") return child.startsWith("$") ? [child] : [];
    return Array.isArray(child)
      ? child.filter((item): item is string => typeof item === "string" && item.startsWith("$"))
      : [];
  });
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

type ResolvedEntity = StoredEntity & { readonly entity: VersionedEntityType };

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
  // ancestor move bulk-reprojects its relational ownership without changing its
  // document revision.
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
    case "schedule": {
      return await applySchedule(run, operation);
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
 * is unique *per project*: `S-12` exists in every project that has twelve
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

/** The project named as parent of a project-owned Epic, Rule or Milestone. */
async function resolveProject(
  run: Execution,
  ref: PlanRef,
  path: string,
): Promise<{ ok: true; id: string } | { ok: false; refusal: Refusal }> {
  if (ref.kind !== "project") {
    return {
      ok: false,
      refusal: invalid(
        shapeIssue(path, "An Epic, Rule or Milestone parent is a project, named by its name."),
      ),
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
  entity: VersionedEntityType,
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
    case "rule": {
      return await ruleRepository.findByKey(run.scope, { projectId, key }, run.tx);
    }
    case "milestone": {
      return await milestoneRepository.findByKey(run.scope, { projectId, key }, run.tx);
    }
  }
}

/* ------------------------------------------------------ 4./5. the document */

const SCHEMA_VERSION = {
  epic: EPIC_SCHEMA_VERSION,
  stream: STREAM_SCHEMA_VERSION,
  task: TASK_SCHEMA_VERSION,
  rule: RULE_SCHEMA_VERSION,
  milestone: MILESTONE_SCHEMA_VERSION,
} as const satisfies Record<VersionedEntityType, string>;

/** Which `links` field records the parent, and therefore what the server fills in. */
const PARENT_LINK = {
  epic: null,
  stream: "parent_epic_id",
  task: "parent_stream_id",
  rule: null,
  milestone: null,
} as const satisfies Record<VersionedEntityType, string | null>;

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
  rule: "statement",
  milestone: "goal",
} as const satisfies Record<VersionedEntityType, string>;

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/**
 * Reads the immutable Source catalogue only when it is structurally complete
 * enough to compare by id. Malformed candidate shapes remain the document
 * parser's responsibility, so this invariant does not hide a more useful schema
 * issue behind a false "removed" report.
 */
const sourceCatalogue = (
  document: Record<string, unknown>,
): readonly Record<string, unknown>[] | null => {
  const rawProvenance = document.provenance;
  if (typeof rawProvenance !== "object" || rawProvenance === null || Array.isArray(rawProvenance)) {
    return null;
  }
  const rawSources = (rawProvenance as Record<string, unknown>).sources;
  if (rawSources === undefined) return [];
  if (!Array.isArray(rawSources)) return null;
  const sources = rawSources.flatMap((source) => {
    const parsed = provenanceSource.safeParse(source);
    return parsed.success ? [parsed.data as Record<string, unknown>] : [];
  });
  if (sources.length !== rawSources.length) return null;
  const ids = sources.map((source) => source.id as string);
  return new Set(ids).size === ids.length ? sources : null;
};

const immutableSourceIssue = (path: string, id: string): DocumentIssue =>
  shapeIssue(
    path,
    `provenance.sources is immutable and append-only; ${id} cannot be rewritten, removed or reused. Add a new SRC-* Source and use supersedes_source_ids when correcting an earlier observation.`,
  );

/** Existing Source identities and their complete observations form an append-only set. */
function sourceSectionReplacementIssues(
  before: Record<string, unknown>,
  afterSectionPatch: Record<string, unknown>,
  path: string,
): readonly DocumentIssue[] {
  const beforeSources = sourceCatalogue(before);
  const afterSources = sourceCatalogue(afterSectionPatch);
  if (beforeSources === null || afterSources === null) return [];
  const afterById = new Map(
    afterSources.map((source, index) => [source.id as string, { source, index }]),
  );

  return beforeSources.flatMap((source) => {
    const id = source.id as string;
    const replacement = afterById.get(id);
    if (replacement === undefined) {
      return [immutableSourceIssue(path, id)];
    }
    return diffDocuments(source, replacement.source).length === 0
      ? []
      : [immutableSourceIssue(`${path}[${String(replacement.index)}]`, id)];
  });
}

/**
 * Item mutations may only append a not-yet-declared Source. This also rejects a
 * no-op `replace` and a rewrite of a Source introduced by the section patch or an
 * earlier item: an immutable observation is cited or superseded, never edited.
 */
function sourceItemMutationIssues(
  afterSectionPatch: Record<string, unknown>,
  operation: Extract<PlannedOperation, { kind: "update" }>,
): readonly DocumentIssue[] {
  const stagedSources = sourceCatalogue(afterSectionPatch);
  if (stagedSources === null) return [];
  const knownIds = new Set(stagedSources.map((source) => source.id as string));

  return operation.items.flatMap((item, itemIndex) => {
    if (item.path !== "provenance.sources") return [];
    const path = `operations[${String(operation.index)}].items[${String(itemIndex)}]`;
    if (item.action !== "add") {
      return [immutableSourceIssue(`${path}.action`, item.id)];
    }
    if (knownIds.has(item.id)) {
      return [immutableSourceIssue(`${path}.id`, item.id)];
    }
    knownIds.add(item.id);
    return [];
  });
}

const isHierarchyEntityType = (entity: VersionedEntityType): entity is HierarchyEntityType =>
  (HIERARCHY_ENTITY_TYPE as readonly string[]).includes(entity);

const isLinkableEntityType = (entity: VersionedEntityType): entity is LinkableEntityType =>
  (LINKABLE_ENTITY_TYPE as readonly string[]).includes(entity);

const RULE_REFERENCE_FIELDS = new Set(["rule_key", "rule_keys", "constrained_by_rule_keys"]);

/** Replaces embedded `$rule` references after their create has issued an R-key. */
function canonicalizeRuleReferences(value: unknown, run: Execution): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeRuleReferences(item, run));
  }
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, child]) => {
      if (RULE_REFERENCE_FIELDS.has(key)) {
        const resolve = (candidate: unknown): unknown => {
          if (typeof candidate !== "string" || !candidate.startsWith("$")) return candidate;
          const resolved = run.resolvedByTemp.get(candidate);
          if (resolved?.entity !== "rule") {
            throw new DomainError(
              "rule_temp_unresolved",
              `${candidate} reached document canonicalization without a preceding Rule create.`,
            );
          }
          return resolved.key;
        };
        return [key, Array.isArray(child) ? child.map(resolve) : resolve(child)];
      }
      return [key, canonicalizeRuleReferences(child, run)];
    }),
  );
}

function summaryOf(entity: VersionedEntityType, document: Record<string, unknown>): string | null {
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
 * Stamps the Stream snapshot a Task started and finished against.
 *
 * These fields are intentionally absent from the agent-tier schema. A Task that
 * first reaches an execution-or-later status captures the parent revision once;
 * completing it pins that same snapshot instead of silently claiming a newer
 * Stream revision that changed while the Task was underway.
 */
function withTaskTrace(
  document: Record<string, unknown>,
  parent: { readonly key: string; readonly revision: number },
  ruleRevisions: readonly { readonly rule_key: string; readonly revision: number }[] = [],
): Record<string, unknown> {
  const status = asRecord(document.meta).status;
  const executionStatuses = new Set(["in_progress", "blocked", "in_review", "done"]);
  const existing = asRecord(document.execution);
  if (existing.trace_state === PRE_V2_TRACE_NOT_RECORDED) {
    // This terminal Task predates v2 trace capture. A later metadata or
    // provenance correction must not turn today's Stream and Rules into a
    // fabricated historical claim.
    return document;
  }
  const priorStarted = existing.stream_revision_started;
  const started =
    typeof priorStarted === "number" && Number.isInteger(priorStarted) && priorStarted > 0
      ? priorStarted
      : executionStatuses.has(String(status))
        ? parent.revision
        : null;
  if (started === null) {
    return document;
  }

  const nextExecution: Record<string, unknown> = {
    ...existing,
    stream_revision_started: started,
  };
  if (status === "done" || status === "cancelled") {
    nextExecution.stream_revision_used = {
      stream_key: parent.key,
      revision: started,
    };
    nextExecution.rule_revisions_used = Array.isArray(existing.rule_revisions_used)
      ? existing.rule_revisions_used
      : ruleRevisions;
  }
  return { ...document, execution: nextExecution };
}

const hasPreV2UnrecordedTrace = (document: Record<string, unknown>): boolean =>
  asRecord(document.execution).trace_state === PRE_V2_TRACE_NOT_RECORDED;

const serverOwnedTaskTraceFields = [
  "trace_state",
  "stream_revision_started",
  "stream_revision_used",
  "rule_revisions_used",
] as const;

/**
 * Restores trace fields from the stored Task before ordinary update logic runs.
 * This is deliberately separate from the input rejection above: even if patch
 * semantics change later, omitting a server field can never erase history and
 * make `withTaskTrace` replace it with current state.
 */
function withPreservedTaskTrace(
  document: Record<string, unknown>,
  previousDocument: Record<string, unknown>,
): Record<string, unknown> {
  const hadExecution =
    (typeof document.execution === "object" && document.execution !== null) ||
    (typeof previousDocument.execution === "object" && previousDocument.execution !== null);
  const execution = { ...asRecord(document.execution) };
  const previous = asRecord(previousDocument.execution);
  for (const field of serverOwnedTaskTraceFields) {
    if (Object.hasOwn(previous, field)) {
      execution[field] = previous[field];
    } else {
      delete execution[field];
    }
  }
  return hadExecution ? { ...document, execution } : document;
}

/** Re-bases non-terminal execution trace when a confirmed move changes the parent Stream. */
function withRebasedTaskTrace(
  document: Record<string, unknown>,
  parent: { readonly key: string; readonly revision: number },
): Record<string, unknown> {
  const execution = { ...asRecord(document.execution) };
  delete execution.stream_revision_started;
  delete execution.stream_revision_used;
  delete execution.rule_revisions_used;
  return withTaskTrace({ ...document, execution }, parent);
}

/** Explicitly adopts the current parent snapshot while retaining one start pin. */
function withExplicitTaskRebase(
  document: Record<string, unknown>,
  parentRevision: number,
): Record<string, unknown> {
  const execution = { ...asRecord(document.execution) };
  delete execution.stream_revision_used;
  delete execution.rule_revisions_used;
  execution.stream_revision_started = parentRevision;
  return { ...document, execution };
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
  entity: VersionedEntityType,
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
 * how strict to be: an agent's input is checked against a `meta` that rejects its
 * server-owned fields, and a document read back out of the table is checked
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
  const parentContent = asRecord(parentDocument.content);
  const requirements = asRecord(parentContent.requirements);
  const ids = (...collections: unknown[]): Set<string> =>
    new Set(
      collections
        .flatMap((collection) => idsOf(collection))
        .filter((id): id is string => id !== null),
    );
  const known = {
    requirement_ids: ids(requirements.functional, requirements.non_functional),
    acceptance_criteria_ids: ids(parentContent.acceptance_criteria),
    behavior_case_ids: ids(parentContent.behavior_cases),
    change_ids: ids(parentContent.changes),
    hypothesis_ids: ids(parentContent.hypotheses),
    research_question_ids: ids(parentContent.research_questions),
    success_criteria_ids: ids(parentContent.success_criteria),
    decision_rule_ids: ids(parentContent.decision_rules),
    investigation_question_ids: ids(parentContent.questions),
    refactor_target_ids: ids(parentContent.refactor_targets),
    invariant_ids: ids(parentContent.invariants),
    quality_goal_ids: ids(parentContent.quality_goals),
    maintenance_goal_ids: ids(parentContent.maintenance_goals),
  } as const;
  const issues: DocumentIssue[] = [];
  for (const [field, knownIds] of Object.entries(known)) {
    const referenced = section[field];
    if (!Array.isArray(referenced)) {
      continue;
    }
    referenced.forEach((id, position) => {
      if (typeof id === "string" && !knownIds.has(id)) {
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

function localDocumentReferenceIssues(
  document: Record<string, unknown>,
  path: string,
): readonly DocumentIssue[] {
  if (document.entity !== "stream") return [];
  const content = asRecord(document.content);
  const requirements = asRecord(content.requirements);
  const known = new Set(
    [...idsOf(requirements.functional), ...idsOf(requirements.non_functional)].filter(
      (id): id is string => id !== null,
    ),
  );
  const criteria = Array.isArray(content.acceptance_criteria) ? content.acceptance_criteria : [];
  return criteria.flatMap((criterion, criterionIndex) => {
    const referenced = asRecord(asRecord(criterion).verifies).requirement_ids;
    if (!Array.isArray(referenced)) return [];
    return referenced.flatMap((id, idIndex) =>
      typeof id === "string" && !known.has(id)
        ? [
            ruleIssue(
              "referenced_ids_must_exist",
              `${path}.content.acceptance_criteria[${String(criterionIndex)}].verifies.requirement_ids[${String(idIndex)}]`,
            ),
          ]
        : [],
    );
  });
}

type StructuredRuleReference = { readonly key: string; readonly path: string };

function structuredRuleReferences(value: unknown, path = ""): readonly StructuredRuleReference[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      structuredRuleReferences(item, `${path}[${String(index)}]`),
    );
  }
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([field, child]) => {
    const childPath = path.length === 0 ? field : `${path}.${field}`;
    if (field === "rule_key" && typeof child === "string") {
      return [{ key: child, path: childPath }];
    }
    if ((field === "rule_keys" || field === "constrained_by_rule_keys") && Array.isArray(child)) {
      return child.flatMap((key, index) =>
        typeof key === "string" ? [{ key, path: `${childPath}[${String(index)}]` }] : [],
      );
    }
    return structuredRuleReferences(child, childPath);
  });
}

async function ruleReferenceIssues(
  run: Execution,
  projectId: string,
  document: Record<string, unknown>,
  operationPath: string,
  previousDocument?: Record<string, unknown>,
): Promise<readonly DocumentIssue[]> {
  const references = structuredRuleReferences(document);
  if (references.length === 0) return [];
  const rules = await ruleRepository.listByKeys(
    run.scope,
    { projectId, keys: [...new Set(references.map((reference) => reference.key))] },
    run.tx,
  );
  const byKey = new Map(rules.map((row) => [row.key, row]));
  const previousKeys = new Set(
    previousDocument === undefined
      ? []
      : structuredRuleReferences(previousDocument).map((reference) => reference.key),
  );
  const wasActive = previousDocument !== undefined && activeRuleConsumerDocument(previousDocument);
  const isActive = activeRuleConsumerDocument(document);
  return references.flatMap((reference) => {
    const resolved = byKey.get(reference.key);
    if (resolved === undefined) {
      return [ruleIssue("referenced_ids_must_exist", `${operationPath}.${reference.path}`)];
    }
    const isHistoricalPin = reference.path.startsWith("execution.rule_revisions_used");
    const newlyApplied = !wasActive || !previousKeys.has(reference.key);
    return resolved.status === "deprecated" && isActive && newlyApplied && !isHistoricalPin
      ? [
          shapeIssue(
            `${operationPath}.${reference.path}`,
            `${reference.key} is deprecated and cannot be newly applied to active work.`,
          ),
        ]
      : [];
  });
}

function activeRuleConsumerDocument(document: Record<string, unknown>): boolean {
  const entity = document.entity;
  const status = String(asRecord(document.meta).status);
  if (entity === "epic") return status === "active";
  if (entity === "stream") return ["ready", "in_progress", "blocked"].includes(status);
  if (entity === "task") return ["ready", "in_progress", "blocked", "in_review"].includes(status);
  return false;
}

type RuleConsumers = {
  readonly all: readonly string[];
  readonly active: readonly string[];
};

async function ruleConsumers(
  run: Execution,
  projectId: string,
  ruleKey: string,
): Promise<RuleConsumers> {
  const [epics, streams, tasks] = await Promise.all([
    epicRepository.listByProject(run.scope, projectId, run.tx),
    streamRepository.listByProject(run.scope, projectId, run.tx),
    taskRepository.listByProject(run.scope, projectId, run.tx),
  ]);
  const consumers = [...epics, ...streams, ...tasks].filter((row) =>
    structuredRuleReferences(row.document).some((reference) => reference.key === ruleKey),
  );
  const active = consumers.filter((row) => activeRuleConsumerDocument(row.document));
  return {
    all: consumers.map((row) => row.key).sort(),
    active: active.map((row) => row.key).sort(),
  };
}

const stringArray = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

const applicationRuleKeys = (document: Record<string, unknown>): readonly string[] => {
  const applications = asRecord(document.content).rule_applications;
  return Array.isArray(applications)
    ? applications.flatMap((application) => {
        const key = asRecord(application).rule_key;
        return typeof key === "string" ? [key] : [];
      })
    : [];
};

type TaskRulePins =
  | {
      readonly ok: true;
      readonly pins: readonly { readonly rule_key: string; readonly revision: number }[];
    }
  | { readonly ok: false; readonly missing: readonly string[] };

type TaskReferenceStream =
  | { readonly ok: true; readonly document: Record<string, unknown> | null }
  | { readonly ok: false; readonly revision: number };

/**
 * The Stream document a Task is allowed to claim it implemented.
 *
 * Planned work without a trace validates against the current parent. Once work
 * starts, every later edit validates against that captured snapshot as context
 * projection does; otherwise an active Task could accept a target added later
 * and only discover at completion that its claimed start revision never
 * contained it. A move is the explicit rebase boundary for non-terminal work.
 */
async function taskReferenceStream(
  run: Execution,
  taskDocument: Record<string, unknown>,
  parentStream: {
    readonly id: string;
    readonly revision: number;
    readonly document: Record<string, unknown>;
  },
): Promise<TaskReferenceStream> {
  if (hasPreV2UnrecordedTrace(taskDocument)) {
    // There is no honest historical Stream document to validate against. In
    // particular, do not use the current parent as a silent substitute.
    return { ok: true, document: null };
  }
  const execution = asRecord(taskDocument.execution);
  const used = asRecord(execution.stream_revision_used).revision;
  const hasUsedRevision = typeof used === "number" && Number.isInteger(used) && used > 0;
  const started = execution.stream_revision_started;
  const hasStartedRevision =
    typeof started === "number" && Number.isInteger(started) && started > 0;
  if (!hasUsedRevision && !hasStartedRevision) {
    return { ok: true, document: parentStream.document };
  }
  const revision = hasUsedRevision ? used : hasStartedRevision ? started : parentStream.revision;
  if (revision === parentStream.revision) {
    return { ok: true, document: parentStream.document };
  }
  const snapshot = await findRevisionDocument(
    run.scope,
    { entity: "stream", id: parentStream.id, revision },
    run.tx,
  );
  return snapshot === null ? { ok: false, revision } : { ok: true, document: snapshot };
}

/**
 * Resolves the exact Rule set projected into a Task context.
 *
 * Epic and Stream applications are inherited. Task constraints are direct. An
 * Acceptance Criterion contributes its Rules only when the Task names that AC or
 * implements a Requirement the AC verifies; unrelated criteria in the same
 * Stream must not make a terminal Task claim that it used their Rules.
 */
async function effectiveTaskRulePins(
  run: Execution,
  taskDocument: Record<string, unknown>,
  parentStream: {
    readonly epicId: string;
    readonly projectId: string;
    readonly document: Record<string, unknown>;
  },
): Promise<TaskRulePins> {
  if (hasPreV2UnrecordedTrace(taskDocument)) {
    // The migration could not prove which Rule revisions this terminal Task
    // used. Returning an empty historical set is truthful; resolving today's
    // definitions here would make a later edit invent execution history.
    return { ok: true, pins: [] };
  }
  const status = asRecord(taskDocument.meta).status;
  const execution = asRecord(taskDocument.execution);
  const started = execution.stream_revision_started;
  const hasStartedRevision =
    typeof started === "number" && Number.isInteger(started) && started > 0;
  if (status !== "done" && !(status === "cancelled" && hasStartedRevision)) {
    return { ok: true, pins: [] };
  }
  const existingPins = execution.rule_revisions_used;
  if (Array.isArray(existingPins)) {
    return {
      ok: true,
      pins: existingPins.flatMap((pin) => {
        const item = asRecord(pin);
        return typeof item.rule_key === "string" &&
          typeof item.revision === "number" &&
          Number.isInteger(item.revision) &&
          item.revision > 0
          ? [{ rule_key: item.rule_key, revision: item.revision }]
          : [];
      }),
    };
  }

  const epic = await epicRepository.findById(run.scope, parentStream.epicId, run.tx);
  if (epic === null) {
    throw new DomainError(
      "task_parent_epic_missing",
      "A Task reached completion while its parent Stream had no Epic.",
    );
  }

  const implementation = asRecord(asRecord(taskDocument.content).implements);
  const requirementIds = new Set(stringArray(implementation.requirement_ids));
  const acceptanceCriteriaIds = new Set(stringArray(implementation.acceptance_criteria_ids));
  const streamContent = asRecord(parentStream.document.content);
  const acceptanceCriteria = Array.isArray(streamContent.acceptance_criteria)
    ? streamContent.acceptance_criteria
    : [];
  const criterionRuleKeys = acceptanceCriteria.flatMap((criterion) => {
    const item = asRecord(criterion);
    const verifies = asRecord(item.verifies);
    const relevantById = typeof item.id === "string" && acceptanceCriteriaIds.has(item.id);
    const relevantByRequirement = stringArray(verifies.requirement_ids).some((id) =>
      requirementIds.has(id),
    );
    return relevantById || relevantByRequirement ? stringArray(verifies.rule_keys) : [];
  });
  const keys = [
    ...applicationRuleKeys(epic.document),
    ...applicationRuleKeys(parentStream.document),
    ...stringArray(asRecord(taskDocument.content).constrained_by_rule_keys),
    ...criterionRuleKeys,
  ].filter((key, index, all) => all.indexOf(key) === index);
  if (keys.length === 0) {
    return { ok: true, pins: [] };
  }

  const rules = await ruleRepository.listByKeys(
    run.scope,
    { projectId: parentStream.projectId, keys },
    run.tx,
  );
  const byKey = new Map(rules.map((rule) => [rule.key, rule]));
  const missing = keys.filter((key) => !byKey.has(key));
  if (missing.length > 0) {
    return { ok: false, missing };
  }
  return {
    ok: true,
    pins: keys
      .flatMap((key) => {
        const rule = byKey.get(key);
        return rule === undefined ? [] : [{ rule_key: key, revision: rule.revision }];
      })
      .sort((left, right) => left.rule_key.localeCompare(right.rule_key)),
  };
}

type PreparedTaskCancellation =
  | { readonly ok: true; readonly document: Record<string, unknown> }
  | { readonly ok: false; readonly refusal: Refusal };

/** Preserves the context consumed by started work when a Task is cancelled. */
async function prepareTaskCancellation(
  run: Execution,
  target: ResolvedEntity,
  path: string,
): Promise<PreparedTaskCancellation> {
  const parentStreamId = asRecord(target.document.links).parent_stream_id;
  if (typeof parentStreamId !== "string") {
    return { ok: false, refusal: invalid(ruleIssue("referenced_ids_must_exist", path)) };
  }
  const parentStream = await streamRepository.findById(run.scope, parentStreamId, run.tx);
  if (parentStream === null) {
    return { ok: false, refusal: invalid(ruleIssue("referenced_ids_must_exist", path)) };
  }
  let document: Record<string, unknown> = {
    ...target.document,
    meta: { ...asRecord(target.document.meta), status: "cancelled" },
  };
  const referenceStream = await taskReferenceStream(run, document, parentStream);
  if (!referenceStream.ok) {
    return {
      ok: false,
      refusal: invalid(
        shapeIssue(
          `${path}.execution.stream_revision_started`,
          `The Task started against Stream revision ${String(referenceStream.revision)}, but that snapshot does not exist. Cancellation cannot replace it with today's Stream implicitly.`,
        ),
      ),
    };
  }
  const rulePins =
    referenceStream.document === null
      ? ({ ok: true, pins: [] } as const)
      : await effectiveTaskRulePins(run, document, {
          ...parentStream,
          document: referenceStream.document,
        });
  if (!rulePins.ok) {
    return {
      ok: false,
      refusal: invalid(
        shapeIssue(
          `${path}.content`,
          `The effective Rule set contains missing keys: ${rulePins.missing.join(", ")}.`,
        ),
      ),
    };
  }
  document = withTaskTrace(
    document,
    { key: parentStream.key, revision: parentStream.revision },
    rulePins.pins,
  );
  const parsed = parseAt(document, "store", path);
  if (!parsed.ok) return parsed;
  const referenceIssues = [
    ...(referenceStream.document === null
      ? []
      : implementedIdIssues(parsed.document, referenceStream.document, path)),
    ...(await ruleReferenceIssues(run, target.projectId, parsed.document, path, target.document)),
  ];
  return referenceIssues.length > 0
    ? { ok: false, refusal: invalid(...referenceIssues) }
    : { ok: true, document: parsed.document };
}

const idsOf = (value: unknown): readonly (string | null)[] =>
  Array.isArray(value)
    ? value.map((element) => {
        const id: unknown = asRecord(element).id;
        return typeof id === "string" ? id : null;
      })
    : [];

const STREAM_TARGET_REFERENCE_FIELD = {
  "content.requirements.functional": "requirement_ids",
  "content.requirements.non_functional": "requirement_ids",
  "content.acceptance_criteria": "acceptance_criteria_ids",
  "content.behavior_cases": "behavior_case_ids",
  "content.changes": "change_ids",
  "content.hypotheses": "hypothesis_ids",
  "content.research_questions": "research_question_ids",
  "content.success_criteria": "success_criteria_ids",
  "content.decision_rules": "decision_rule_ids",
  "content.questions": "investigation_question_ids",
  "content.refactor_targets": "refactor_target_ids",
  "content.invariants": "invariant_ids",
  "content.quality_goals": "quality_goal_ids",
  "content.maintenance_goals": "maintenance_goal_ids",
} as const;

/**
 * Refuses an id removal while a structured reference still points at it.
 *
 * Reads the transaction's current rows, so a ref removed by an earlier operation
 * in this same set is already gone. Full section replace and `items.remove` both
 * arrive here as the same canonical before/after transition.
 */
async function referencedRemovalIssues(
  run: Execution,
  target: ResolvedEntity,
  candidate: Record<string, unknown>,
  operationPath: string,
): Promise<readonly DocumentIssue[]> {
  const removals = diffDocuments(target.document, candidate).flatMap((change) =>
    change.kind === "id_collection" ? change.removed.map((id) => ({ path: change.path, id })) : [],
  );
  if (removals.length === 0) {
    return [];
  }

  const referrers = new Map<string, string[]>();
  const add = (collectionPath: string, id: string, paths: readonly string[]): void => {
    if (paths.length === 0) return;
    const key = `${collectionPath}\u0000${id}`;
    referrers.set(key, [...(referrers.get(key) ?? []), ...paths]);
  };

  for (const removal of removals) {
    if (removal.path === "provenance.sources") {
      add(removal.path, removal.id, findArrayValuePaths(candidate, "source_ids", removal.id));
      add(
        removal.path,
        removal.id,
        findArrayValuePaths(candidate, "supersedes_source_ids", removal.id),
      );
    }
    if (
      removal.path === "content.requirements.functional" ||
      removal.path === "content.requirements.non_functional"
    ) {
      add(removal.path, removal.id, findArrayValuePaths(candidate, "requirement_ids", removal.id));
    }
  }

  if (target.entity === "stream") {
    const tasks = await taskRepository.listByStreams(
      run.scope,
      { streamIds: [target.id], statuses: [...TASK_STATUS] },
      run.tx,
    );
    for (const removal of removals) {
      const field =
        STREAM_TARGET_REFERENCE_FIELD[removal.path as keyof typeof STREAM_TARGET_REFERENCE_FIELD];
      if (field === undefined) continue;
      for (const child of tasks) {
        const usedStreamRevision = asRecord(
          asRecord(child.document.execution).stream_revision_used,
        ).revision;
        const historicalTerminalReference =
          (child.status === "done" || child.status === "cancelled") &&
          ((typeof usedStreamRevision === "number" &&
            Number.isInteger(usedStreamRevision) &&
            usedStreamRevision > 0) ||
            hasPreV2UnrecordedTrace(child.document));
        if (historicalTerminalReference) {
          // A pin resolves inside its immutable Stream snapshot. An explicit
          // pre-v2 gap has no truthful snapshot at all. Neither is a reference
          // to the current Stream revision being edited.
          continue;
        }
        const implementation = asRecord(asRecord(child.document.content).implements);
        const values = implementation[field];
        if (Array.isArray(values) && values.includes(removal.id)) {
          add(removal.path, removal.id, [`${child.key}.content.implements.${field}`]);
        }
      }
    }
  }

  return removals.flatMap((removal) => {
    const paths = [...new Set(referrers.get(`${removal.path}\u0000${removal.id}`) ?? [])].sort();
    return paths.length === 0
      ? []
      : [
          shapeIssue(
            `${operationPath}.${removal.path}`,
            `Cannot remove ${removal.id}; it is still referenced by ${paths.join(", ")}. Remove or replace those references in an earlier operation in this change set.`,
          ),
        ];
  });
}

function findArrayValuePaths(
  value: unknown,
  field: string,
  expected: string,
  path = "",
): readonly string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      findArrayValuePaths(item, field, expected, `${path}[${String(index)}]`),
    );
  }
  if (typeof value !== "object" || value === null) {
    return [];
  }
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => {
    const childPath = path.length === 0 ? key : `${path}.${key}`;
    if (key === field && Array.isArray(child) && child.includes(expected)) {
      return [childPath];
    }
    return findArrayValuePaths(child, field, expected, childPath);
  });
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
  operation: Extract<PlannedOperation, { kind: "archive" | "delete" | "move" | "update" }>,
  destructiveSectionReplacement = false,
): Refusal | null {
  const removesItems =
    operation.kind === "update" &&
    (destructiveSectionReplacement || operation.items.some((item) => item.action === "remove"));
  const rebasesExecution = operation.kind === "update" && operation.rebaseStreamRevision;
  if (
    (operation.kind === "update" && !removesItems && !rebasesExecution) ||
    !run.enforceConfirmation ||
    run.changeSet.operations[operation.index]?.confirm === true
  ) {
    return null;
  }
  return {
    ok: false,
    code: "destructive_requires_confirm",
    index: operation.index,
    operation: operation.kind,
    key: operation.target.key,
    message: `${operation.kind}${removesItems ? " that removes id-bearing content" : ""}${rebasesExecution ? " that rebases captured Stream execution context" : ""} of ${operation.target.key} needs confirm: true. ${DESTRUCTIVE_REMEDIATION}`,
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
  let parentEntity: ResolvedEntity | null = null;
  if (
    operation.entity === "epic" ||
    operation.entity === "rule" ||
    operation.entity === "milestone"
  ) {
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
    parentEntity = parent.value;
  }

  const built = buildCreateDocument(
    operation.entity,
    canonicalizeRuleReferences(operation.data, run) as Record<string, unknown>,
    parentId,
    path,
  );
  if (!built.ok) {
    return built.refusal;
  }
  const parsedDocument = parseAt(built.document, "agent", path);
  if (!parsedDocument.ok) {
    return parsedDocument.refusal;
  }
  let document = parsedDocument.document;
  if (operation.entity === "task" && parentEntity?.entity === "stream") {
    const parentStream = await streamRepository.findById(run.scope, parentEntity.id, run.tx);
    if (parentStream === null) {
      return invalid(ruleIssue("referenced_ids_must_exist", parentPath));
    }
    const rulePins = await effectiveTaskRulePins(run, document, parentStream);
    if (!rulePins.ok) {
      return invalid(
        shapeIssue(
          `${path}.content.implements`,
          `The effective Rule set contains missing keys: ${rulePins.missing.join(", ")}.`,
        ),
      );
    }
    document = withTaskTrace(document, parentEntity, rulePins.pins);
  }

  if (operation.entity === "task") {
    const issues =
      parentEntity?.entity === "stream"
        ? implementedIdIssues(document, parentEntity.document, path)
        : [];
    if (issues.length > 0) {
      return invalid(...issues);
    }
  }
  const documentReferenceIssues = [
    ...localDocumentReferenceIssues(document, path),
    ...(await ruleReferenceIssues(run, projectId, document, path)),
  ];
  if (documentReferenceIssues.length > 0) {
    return invalid(...documentReferenceIssues);
  }

  const written = await insertEntity(
    run,
    operation.entity,
    projectId,
    parentId,
    document,
    operation.roadmapOrder,
  );
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
  record(run, operation.index, "create", created, operation.ref, [
    entityDiff("created", created.entity, created.key, created.document),
  ]);
  return null;
}

async function insertEntity(
  run: Execution,
  entity: VersionedEntityType,
  projectId: string,
  parentId: string | null,
  document: Record<string, unknown>,
  roadmapOrder: number | null,
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
    case "rule": {
      return await ruleRepository.insert(run.scope, common, run.tx);
    }
    case "milestone": {
      if (roadmapOrder === null) {
        throw new DomainError(
          "milestone_order_missing",
          "A Milestone reached insert without order.",
        );
      }
      return await milestoneRepository.insert(run.scope, { ...common, roadmapOrder }, run.tx);
    }
  }
}

/** Unreachable: `planChangeSet` requires a parent for a stream and a task. */
function requireParent(parentId: string | null, entity: HierarchyEntityType): string {
  if (parentId === null) {
    throw new DomainError("parent_unresolved", `A ${entity} reached the insert with no parent.`);
  }
  return parentId;
}

async function applyUpdate(
  run: Execution,
  operation: Extract<PlannedOperation, { kind: "update" }>,
): Promise<Refusal | null> {
  const operationPath = `operations[${String(operation.index)}]`;
  const path = `${operationPath}.data`;
  const target = await resolveRef(
    run,
    operation.target,
    `operations[${String(operation.index)}].key`,
    operation.index,
  );
  if (!target.ok) {
    return target.refusal;
  }

  const protocolIssues = updateProtocolIssues(operation);
  if (protocolIssues.length > 0) {
    return invalid(...protocolIssues);
  }

  // Section-level replace, not an array deep-merge: what an author sent is what
  // that section now says. `patch.ts` carries the argument.
  const canonicalData =
    operation.data === null
      ? null
      : (canonicalizeRuleReferences(operation.data, run) as Record<string, unknown>);
  const patched =
    canonicalData === null
      ? { ok: true as const, document: target.value.document }
      : applySectionPatch(target.value.document, canonicalData);
  if (!patched.ok) {
    return prefixed(patched.issues, path);
  }
  const immutableSourceIssues = [
    ...sourceSectionReplacementIssues(
      target.value.document,
      patched.document,
      `${path}.provenance.sources`,
    ),
    ...sourceItemMutationIssues(patched.document, operation),
  ];
  if (immutableSourceIssues.length > 0) {
    return invalid(...immutableSourceIssues);
  }
  const canonicalItems = operation.items.map((item) => ({
    ...item,
    ...(item.value === undefined
      ? {}
      : { value: canonicalizeRuleReferences(item.value, run) as Record<string, unknown> }),
  }));
  const itemPatched = applyItemMutations(patched.document, canonicalItems);
  if (!itemPatched.ok) {
    return prefixed(itemPatched.issues, operationPath);
  }
  // The store tier, because the merged document retains the server-stamped meta.
  // A submitted patch naming one of those fields was rejected above; the
  // repository still re-stamps them as the final persistence invariant.
  const parentStreamId =
    target.value.entity === "task"
      ? asRecord(target.value.document.links).parent_stream_id
      : undefined;
  const parentStream =
    target.value.entity === "task" && typeof parentStreamId === "string"
      ? await streamRepository.findById(run.scope, parentStreamId, run.tx)
      : null;
  if (operation.rebaseStreamRevision && parentStream === null) {
    return invalid(
      shapeIssue(
        `${operationPath}.rebase_stream_revision`,
        "The Task's current parent Stream no longer exists, so there is no revision to rebase onto.",
      ),
    );
  }
  const canonicalParent =
    target.value.entity === "task" && typeof parentStreamId === "string"
      ? withTaskImplementationStream(itemPatched.document, parentStreamId)
      : itemPatched.document;
  let candidate =
    target.value.entity === "task"
      ? withPreservedTaskTrace(canonicalParent, target.value.document)
      : canonicalParent;
  let referenceStreamDocument = parentStream?.document ?? null;
  if (target.value.entity === "task" && parentStream !== null) {
    if (operation.rebaseStreamRevision) {
      const status = asRecord(target.value.document.meta).status;
      if (status === "done" || status === "cancelled") {
        return invalid(
          shapeIssue(
            `${operationPath}.rebase_stream_revision`,
            "A terminal Task cannot rewrite its captured Stream history. Create follow-up work instead.",
          ),
        );
      }
      const started = asRecord(target.value.document.execution).stream_revision_started;
      if (typeof started !== "number" || !Number.isInteger(started) || started < 1) {
        return invalid(
          shapeIssue(
            `${operationPath}.rebase_stream_revision`,
            "Only a Task that has already captured stream_revision_started can be rebased.",
          ),
        );
      }
      if (started === parentStream.revision) {
        return invalid(
          shapeIssue(
            `${operationPath}.rebase_stream_revision`,
            `The Task already uses the current parent Stream revision ${String(started)}.`,
          ),
        );
      }
      candidate = withExplicitTaskRebase(candidate, parentStream.revision);
    }
    const referenceStream = await taskReferenceStream(run, candidate, parentStream);
    if (!referenceStream.ok) {
      return invalid(
        shapeIssue(
          `${path}.execution.stream_revision_started`,
          `The Task pins Stream revision ${String(referenceStream.revision)}, but that revision snapshot does not exist. It cannot be completed against a different revision implicitly.`,
        ),
      );
    }
    referenceStreamDocument = referenceStream.document;
    const rulePins =
      referenceStream.document === null
        ? ({ ok: true, pins: [] } as const)
        : await effectiveTaskRulePins(run, candidate, {
            ...parentStream,
            document: referenceStream.document,
          });
    if (!rulePins.ok) {
      return invalid(
        shapeIssue(
          `${path}.content.implements`,
          `The effective Rule set contains missing keys: ${rulePins.missing.join(", ")}.`,
        ),
      );
    }
    candidate = withTaskTrace(
      candidate,
      { key: parentStream.key, revision: parentStream.revision },
      rulePins.pins,
    );
  }
  const parsedDocument = parseAt(candidate, "store", path);
  if (!parsedDocument.ok) {
    return parsedDocument.refusal;
  }
  const document = parsedDocument.document;
  const proposedDiff = diffDocuments(target.value.document, document);
  const terminalStatus = {
    epic: "archived",
    stream: "cancelled",
    task: "cancelled",
    rule: "deprecated",
    milestone: "cancelled",
  } as const satisfies Record<VersionedEntityType, string>;
  const previousStatus = asRecord(target.value.document.meta).status;
  const nextStatus = asRecord(document.meta).status;
  if (nextStatus === terminalStatus[target.value.entity] && previousStatus !== nextStatus) {
    return invalid(
      shapeIssue(
        `${path}.meta.status`,
        `Use archive with explicit confirmation to set a ${target.value.entity} to ${String(nextStatus)}. A generic update cannot bypass the retirement guard.`,
      ),
    );
  }
  const existingUsedStreamRevision = asRecord(
    asRecord(target.value.document.execution).stream_revision_used,
  ).revision;
  const hasHistoricalTaskTrace =
    target.value.entity === "task" &&
    ((typeof existingUsedStreamRevision === "number" &&
      Number.isInteger(existingUsedStreamRevision) &&
      existingUsedStreamRevision > 0) ||
      hasPreV2UnrecordedTrace(target.value.document));
  if (hasHistoricalTaskTrace) {
    if (!["done", "cancelled"].includes(String(asRecord(document.meta).status))) {
      return invalid(
        shapeIssue(
          `${path}.meta.status`,
          "A Task with terminal execution history is terminal and cannot be reopened. Create new work for a changed implementation.",
        ),
      );
    }
    const changesCompletedWork = proposedDiff.some(
      (change) =>
        (change.kind === "field" || change.kind === "id_collection") &&
        (change.path === "content" || change.path.startsWith("content.")),
    );
    if (changesCompletedWork) {
      return invalid(
        shapeIssue(
          `${path}.content`,
          "A Task's content is immutable once its terminal execution history is fixed. Create follow-up work instead; metadata, provenance and operational assignment may still be corrected.",
        ),
      );
    }
  }

  if (target.value.entity === "task") {
    const issues =
      referenceStreamDocument === null
        ? []
        : implementedIdIssues(document, referenceStreamDocument, path);
    if (issues.length > 0) {
      return invalid(...issues);
    }
  }

  const documentReferenceIssues = [
    ...localDocumentReferenceIssues(document, path),
    ...(await ruleReferenceIssues(
      run,
      target.value.projectId,
      document,
      path,
      target.value.document,
    )),
  ];
  if (documentReferenceIssues.length > 0) {
    return invalid(...documentReferenceIssues);
  }

  const removalIssues = await referencedRemovalIssues(run, target.value, document, operationPath);
  if (removalIssues.length > 0) {
    return invalid(...removalIssues);
  }

  if (target.value.entity === "milestone" && asRecord(document.meta).status === "completed") {
    const assigned = await milestoneRepository.listAssignedStreams(
      run.scope,
      target.value.id,
      run.tx,
    );
    const unfinished = assigned.filter(
      (stream) => stream.status !== "completed" && stream.status !== "cancelled",
    );
    if (unfinished.length > 0) {
      return invalid(
        shapeIssue(
          `${path}.meta.status`,
          `A Milestone cannot complete while assigned Streams are unfinished: ${unfinished
            .map((stream) => stream.key)
            .join(", ")}.`,
        ),
      );
    }
  }

  if (proposedDiff.length === 0) {
    return invalid(shapeIssue(path, "This update would make no changes."));
  }
  const removesIdBearingContent = proposedDiff.some(
    (change) => change.kind === "id_collection" && change.removed.length > 0,
  );
  const impacted =
    target.value.entity === "rule"
      ? (await ruleConsumers(run, target.value.projectId, target.value.key)).active
      : [];
  if (
    impacted.length > 0 &&
    run.enforceConfirmation &&
    run.changeSet.operations[operation.index]?.confirm !== true
  ) {
    return {
      ok: false,
      code: "destructive_requires_confirm",
      index: operation.index,
      operation: "update",
      key: target.value.key,
      message: `Updating ${target.value.key} affects active consumers ${impacted.join(", ")} and needs confirm: true. ${DESTRUCTIVE_REMEDIATION}`,
    };
  }
  const unconfirmed = confirmationRefusal(run, operation, removesIdBearingContent);
  if (unconfirmed) {
    return unconfirmed;
  }

  const written = await bumpEntity(run, target.value, operation.expectedRevision, document);
  if (!written.ok) {
    return writeRefusal(written, target.value, operation.index, operation.expectedRevision);
  }
  refresh(run, target.value, written.row);
  record(run, operation.index, "update", { ...written.row, entity: target.value.entity }, null, [
    ...diffDocuments(target.value.document, written.row.document),
    ...(impacted.length > 0 ? [{ kind: "impact" as const, affected: impacted }] : []),
  ]);
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
    case "rule": {
      return await ruleRepository.bumpRevision(run.scope, common, run.tx);
    }
    case "milestone": {
      return await milestoneRepository.bumpRevision(run.scope, common, run.tx);
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
  const operationPath = `operations[${String(operation.index)}]`;
  const ruleConsumerSnapshot =
    target.value.entity === "rule"
      ? await ruleConsumers(run, target.value.projectId, target.value.key)
      : null;
  if (operation.kind === "delete" && target.value.entity === "rule") {
    if (ruleConsumerSnapshot !== null && ruleConsumerSnapshot.all.length > 0) {
      return invalid(
        shapeIssue(
          `${operationPath}.key`,
          `Cannot delete ${target.value.key}; structured references remain in ${ruleConsumerSnapshot.all.join(", ")}. Remove those references first, or deprecate the Rule instead.`,
        ),
      );
    }
    if (
      await entityLinkRepository.hasLinks(run.scope, { type: "rule", id: target.value.id }, run.tx)
    ) {
      return invalid(
        shapeIssue(
          `${operationPath}.key`,
          `Cannot delete ${target.value.key}; Rule relationships remain. Unlink them first, or deprecate the Rule instead.`,
        ),
      );
    }
  }
  if (
    operation.kind === "archive" &&
    ruleConsumerSnapshot !== null &&
    ruleConsumerSnapshot.active.length > 0 &&
    run.enforceConfirmation &&
    run.changeSet.operations[operation.index]?.confirm !== true
  ) {
    return {
      ok: false,
      code: "destructive_requires_confirm",
      index: operation.index,
      operation: "archive",
      key: target.value.key,
      message: `Deprecating ${target.value.key} affects active consumers ${ruleConsumerSnapshot.active.join(", ")} and needs confirm: true. ${DESTRUCTIVE_REMEDIATION}`,
    };
  }
  if (target.value.entity === "milestone") {
    const assigned = await milestoneRepository.listAssignedStreams(
      run.scope,
      target.value.id,
      run.tx,
    );
    const blocking =
      operation.kind === "delete"
        ? assigned
        : assigned.filter(
            (stream) => stream.status !== "completed" && stream.status !== "cancelled",
          );
    if (blocking.length > 0) {
      return invalid(
        shapeIssue(
          `${operationPath}.key`,
          `${operation.kind === "delete" ? "Deleting" : "Cancelling"} ${target.value.key} would strand assigned Streams: ${blocking
            .map((stream) => stream.key)
            .join(", ")}. Unschedule or finish them first.`,
        ),
      );
    }
  }
  const unconfirmed = confirmationRefusal(run, operation);
  if (unconfirmed) {
    return unconfirmed;
  }

  let retirementDocument: Record<string, unknown> | undefined;
  if (operation.kind === "archive" && target.value.entity === "task") {
    const prepared = await prepareTaskCancellation(run, target.value, operationPath);
    if (!prepared.ok) return prepared.refusal;
    retirementDocument = prepared.document;
  }

  // Read before the write, because a delete cascades: the streams and tasks under a
  // deleted epic are gone by the time the delete returns, and their `entity_link`
  // rows are not — the endpoints are polymorphic, so no foreign key cascades them.
  // Enumerating the subtree afterwards would find nothing and leave every
  // descendant's edges dangling, which is the same orphan-edge bug one level down.
  const subtree =
    operation.kind === "delete" &&
    (HIERARCHY_ENTITY_TYPE as readonly string[]).includes(target.value.entity)
      ? await listDescendants(run.scope, run.tx, {
          type: target.value.entity as HierarchyEntityType,
          id: target.value.id,
        })
      : [];

  const written =
    operation.kind === "archive"
      ? await archiveEntity(run, target.value, operation.expectedRevision, retirementDocument)
      : await deleteEntity(run, target.value, operation.expectedRevision);
  if (!written.ok) {
    return writeRefusal(written, target.value, operation.index, operation.expectedRevision);
  }
  if (operation.kind === "delete") {
    // The deleted entity and everything the cascade took with it. A leftover
    // `blocked_by` edge is one the cycle check would still walk through, reporting
    // a cycle through an entity nobody can look up.
    for (const endpoint of [{ type: target.value.entity, id: target.value.id }, ...subtree]) {
      if ((LINKABLE_ENTITY_TYPE as readonly string[]).includes(endpoint.type)) {
        await entityLinkRepository.unlinkAll(
          run.scope,
          { ...endpoint, type: endpoint.type as LinkableEntityType },
          run.tx,
        );
      }
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
    operation.kind === "delete"
      ? [
          entityDiff("deleted", target.value.entity, target.value.key, target.value.document),
          ...(subtree.length > 0
            ? [
                {
                  kind: "cascade" as const,
                  deleted: subtree.map((descendant) => ({
                    entity: descendant.type,
                    key: descendant.key,
                  })),
                },
              ]
            : []),
        ]
      : [
          ...diffDocuments(target.value.document, written.row.document),
          ...(ruleConsumerSnapshot !== null && ruleConsumerSnapshot.active.length > 0
            ? [{ kind: "impact" as const, affected: ruleConsumerSnapshot.active }]
            : []),
        ],
  );
  return null;
}

/** Removes every cache entry a cascading delete took with its root. */
function evictDeletedSubtree(
  run: Execution,
  endpoints: readonly { readonly type: VersionedEntityType; readonly id: string }[],
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
  document?: Record<string, unknown>,
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
      return await taskRepository.archive(
        run.scope,
        { ...common, ...(document === undefined ? {} : { document }) },
        run.tx,
      );
    }
    case "rule": {
      return await ruleRepository.deprecate(run.scope, common, run.tx);
    }
    case "milestone": {
      return await milestoneRepository.cancel(run.scope, common, run.tx);
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
    case "rule": {
      return await ruleRepository.delete(run.scope, common, run.tx);
    }
    case "milestone": {
      return await milestoneRepository.delete(run.scope, common, run.tx);
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
  if (!isHierarchyEntityType(target.value.entity)) {
    return invalid(shapeIssue(keyPath, "Only Epics, Streams and Tasks have movable parents."));
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
      if (parent.value.entity !== "stream") {
        return invalid(shapeIssue(parentPath, "A Task can move only to a Stream."));
      }
      const taskStatus = asRecord(target.value.document.meta).status;
      const taskExecution = asRecord(target.value.document.execution);
      const usedRevision = asRecord(taskExecution.stream_revision_used).revision;
      const startedRevision = taskExecution.stream_revision_started;
      const hasCapturedHistory =
        [usedRevision, startedRevision].some(
          (revision) => typeof revision === "number" && Number.isInteger(revision) && revision > 0,
        ) || hasPreV2UnrecordedTrace(target.value.document);
      if (taskStatus === "done" || (taskStatus === "cancelled" && hasCapturedHistory)) {
        return invalid(
          shapeIssue(
            keyPath,
            "A terminal Task with fixed execution history cannot be re-parented or rebased. Create or move non-terminal work instead.",
          ),
        );
      }
      taskDocument = withRebasedTaskTrace(
        withTaskImplementationStream(target.value.document, parent.value.id),
        parent.value,
      );
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
      const referenceIssues = await ruleReferenceIssues(
        run,
        parent.value.projectId,
        taskDocument,
        `operations[${String(operation.index)}]`,
        target.value.document,
      );
      if (referenceIssues.length > 0) {
        return invalid(...referenceIssues);
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
  record(
    run,
    operation.index,
    "move",
    { ...written.row, entity: target.value.entity },
    null,
    diffDocuments(target.value.document, written.row.document),
  );
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
  if (!isHierarchyEntityType(target.entity)) {
    return invalid(shapeIssue(path, `${target.key} is not a movable hierarchy entity.`));
  }
  const hierarchyTarget: ResolvedEntity & { readonly entity: HierarchyEntityType } = {
    ...target,
    entity: target.entity,
  };
  const descendants = await listDescendants(run.scope, run.tx, {
    type: hierarchyTarget.entity,
    id: target.id,
  });
  const moving = [
    { type: hierarchyTarget.entity, id: hierarchyTarget.id, key: hierarchyTarget.key },
    ...descendants,
  ];
  const collisions = await findHierarchyKeyCollisions(run.scope, run.tx, {
    projectId: targetProjectId,
    endpoints: moving,
  });
  if (collisions.length > 0) {
    return invalid(
      shapeIssue(
        path,
        `This subtree cannot move because its stable project-scoped keys already exist in the target Project: ${collisions.map(({ type, key }) => `${key} (${type})`).join(", ")}. Move or delete the conflicting destination entities first.`,
      ),
    );
  }
  const overlayIssues = await crossProjectOverlayIssues(run, hierarchyTarget, path);
  if (overlayIssues.length > 0) {
    return invalid(...overlayIssues);
  }
  const links = await entityLinkRepository.moveSubtreeLinks(
    run.scope,
    moving,
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

/**
 * Project-local Rule keys and Milestone placements must never be silently
 * reinterpreted in another project during a hierarchy move.
 */
async function crossProjectOverlayIssues(
  run: Execution,
  target: ResolvedEntity,
  path: string,
): Promise<readonly DocumentIssue[]> {
  const streams =
    target.entity === "epic"
      ? await streamRepository.listByEpic(run.scope, target.id, run.tx)
      : target.entity === "stream"
        ? [await streamRepository.findById(run.scope, target.id, run.tx)].filter(
            (row): row is NonNullable<typeof row> => row !== null,
          )
        : [];
  const tasks =
    target.entity === "task"
      ? [await taskRepository.findById(run.scope, target.id, run.tx)].filter(
          (row): row is NonNullable<typeof row> => row !== null,
        )
      : await taskRepository.listByStreams(
          run.scope,
          { streamIds: streams.map((stream) => stream.id) },
          run.tx,
        );
  const documents = [...(target.entity === "epic" ? [target] : []), ...streams, ...tasks];
  const referenced = documents
    .filter((row) => structuredRuleReferences(row.document).length > 0)
    .map((row) => row.key)
    .sort();
  const scheduled = streams
    .filter((stream) => stream.milestoneId !== null)
    .map((stream) => stream.key);
  return [
    ...(referenced.length > 0
      ? [
          shapeIssue(
            path,
            `This subtree contains project-local Rule references in ${referenced.join(", ")}. Remove or explicitly remap them before the cross-project move; matching R-key text in another project is not the same Rule.`,
          ),
        ]
      : []),
    ...(scheduled.length > 0
      ? [
          shapeIssue(
            path,
            `This subtree contains Milestone assignments in ${scheduled.join(", ")}. Unschedule those Streams before moving projects.`,
          ),
        ]
      : []),
  ];
}

async function applySchedule(
  run: Execution,
  operation: Extract<PlannedOperation, { kind: "schedule" }>,
): Promise<Refusal | null> {
  const path = `operations[${String(operation.index)}]`;
  const target = await resolveRef(run, operation.target, `${path}.key`, operation.index);
  if (!target.ok) return target.refusal;
  const expectedRevision = operation.expectedRevision ?? target.value.revision;

  if (target.value.entity === "milestone") {
    if (operation.roadmapOrder === null) {
      return invalid(shapeIssue(`${path}.roadmap_order`, "Milestone order is missing."));
    }
    const current = await milestoneRepository.findById(run.scope, target.value.id, run.tx);
    if (current === null) return invalid(ruleIssue("referenced_ids_must_exist", `${path}.key`));
    if (current.roadmapOrder === operation.roadmapOrder) {
      return invalid(shapeIssue(path, "This schedule operation would make no changes."));
    }
    const written = await milestoneRepository.bumpRevision(
      run.scope,
      {
        id: current.id,
        expectedRevision,
        document: current.document,
        roadmapOrder: operation.roadmapOrder,
        changedBy: run.actor,
        changeReason: run.reason,
      },
      run.tx,
    );
    if (!written.ok) {
      return writeRefusal(written, target.value, operation.index, expectedRevision);
    }
    refresh(run, target.value, written.row);
    record(
      run,
      operation.index,
      "schedule",
      { ...written.row, entity: "milestone" },
      null,
      diffDocuments(target.value.document, written.row.document),
    );
    return null;
  }

  if (target.value.entity !== "stream") {
    return invalid(shapeIssue(`${path}.key`, "schedule acts on a Stream or Milestone."));
  }
  const current = await streamRepository.findById(run.scope, target.value.id, run.tx);
  if (current === null) return invalid(ruleIssue("referenced_ids_must_exist", `${path}.key`));

  let milestoneId: string | null = null;
  let milestoneKey: string | null = null;
  if (operation.milestone !== null) {
    let resolvedMilestone: Resolution;
    if (operation.milestone.kind === "temp") {
      resolvedMilestone = await resolveRef(
        run,
        operation.milestone,
        `${path}.milestone`,
        operation.index,
      );
    } else {
      // Once the Stream is resolved, its project is the only namespace in
      // which its Milestone can live. This also lets a temp Stream select M-1
      // without becoming ambiguous merely because another project has an M-1.
      const row = await milestoneRepository.findByKey(
        run.scope,
        { projectId: current.projectId, key: operation.milestone.key },
        run.tx,
      );
      resolvedMilestone =
        row === null
          ? {
              ok: false,
              refusal: invalid(ruleIssue("referenced_ids_must_exist", `${path}.milestone`)),
            }
          : { ok: true, value: { ...row, entity: "milestone" } };
    }
    if (!resolvedMilestone.ok) return resolvedMilestone.refusal;
    if (resolvedMilestone.value.entity !== "milestone") {
      return invalid(shapeIssue(`${path}.milestone`, "Stream placement needs a Milestone key."));
    }
    if (resolvedMilestone.value.projectId !== current.projectId) {
      return invalid(
        shapeIssue(`${path}.milestone`, "A Stream and its Milestone must share a project."),
      );
    }
    const status = asRecord(resolvedMilestone.value.document.meta).status;
    if (status === "completed" || status === "cancelled") {
      return invalid(
        shapeIssue(`${path}.milestone`, `Cannot assign work to a ${String(status)} Milestone.`),
      );
    }
    milestoneId = resolvedMilestone.value.id;
    milestoneKey = resolvedMilestone.value.key;
  }
  if (current.milestoneId === milestoneId && current.roadmapRank === operation.roadmapRank) {
    return invalid(shapeIssue(path, "This schedule operation would make no changes."));
  }
  const written = await streamRepository.schedule(
    run.scope,
    {
      id: current.id,
      expectedRevision,
      milestoneId,
      milestoneKey,
      roadmapRank: operation.roadmapRank,
      changedBy: run.actor,
      changeReason: run.reason,
    },
    run.tx,
  );
  if (!written.ok) {
    return writeRefusal(written, target.value, operation.index, expectedRevision);
  }
  refresh(run, target.value, written.row);
  record(
    run,
    operation.index,
    "schedule",
    { ...written.row, entity: "stream" },
    null,
    diffDocuments(target.value.document, written.row.document),
  );
  return null;
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
  if (!isLinkableEntityType(source.value.entity) || !isLinkableEntityType(target.value.entity)) {
    return invalid(
      shapeIssue(
        `operations[${String(operation.index)}]`,
        "Milestones are roadmap overlays and cannot be relationship endpoints.",
      ),
    );
  }
  if (source.value.projectId !== target.value.projectId) {
    return invalid(
      shapeIssue(
        `operations[${String(operation.index)}].target`,
        `${source.value.key} and ${target.value.key} are in different projects, and a relationship does not cross a project.`,
      ),
    );
  }
  if (source.value.entity === target.value.entity && source.value.id === target.value.id) {
    return invalid(
      shapeIssue(
        `operations[${String(operation.index)}].target`,
        "A relationship cannot point an entity at itself.",
      ),
    );
  }
  if (
    (operation.relationship === "blocked_by" || operation.relationship === "blocks") &&
    (source.value.entity !== target.value.entity ||
      !(DEPENDENCY_ENDPOINT_TYPE as readonly string[]).includes(source.value.entity))
  ) {
    return invalid(
      shapeIssue(
        `operations[${String(operation.index)}].relationship`,
        "Hard dependencies must connect peers: Stream to Stream or Task to Task. Epics, Rules, Milestones, and cross-level pairs are not dependency endpoints.",
      ),
    );
  }
  const touchesRule = source.value.entity === "rule" || target.value.entity === "rule";
  const ruleRelationship = ["related_to", "supersedes", "derived_from", "exception_to"].includes(
    operation.relationship,
  );
  if (
    touchesRule &&
    (source.value.entity !== "rule" || target.value.entity !== "rule" || !ruleRelationship)
  ) {
    return invalid(
      shapeIssue(
        `operations[${String(operation.index)}].relationship`,
        "Rule relations connect Rule to Rule and use related_to, derived_from, exception_to, or supersedes.",
      ),
    );
  }
  if (!touchesRule && ["derived_from", "exception_to"].includes(operation.relationship)) {
    return invalid(
      shapeIssue(
        `operations[${String(operation.index)}].relationship`,
        `${operation.relationship} is a Rule-to-Rule relationship.`,
      ),
    );
  }

  const endpoints = {
    projectId: source.value.projectId,
    source: { type: source.value.entity, id: source.value.id },
    target: { type: target.value.entity, id: target.value.id },
    relationship: operation.relationship,
  };
  let changed: boolean;
  if (operation.kind === "link") {
    // The change set's own reason is the only account of why this dependency was
    // declared; `link` never overwrites a reason that is already recorded, so a
    // re-run cannot replace a deliberate one with a generic one.
    const linked = await entityLinkRepository.link(
      run.scope,
      { ...endpoints, reason: run.reason },
      run.tx,
    );
    changed = linked.created;
    run.linkedProjects.add(source.value.projectId);
  } else {
    // A `false` here means there was nothing to remove, which is the same answer
    // `link` gives for a relationship that already exists: the requested state
    // holds. Failing would make re-running a change set destructive.
    changed = await entityLinkRepository.unlink(run.scope, endpoints, run.tx);
  }
  run.applied.push({
    index: operation.index,
    operation: operation.kind,
    entity: null,
    key: null,
    id: null,
    revision: null,
    ref: null,
    diff: [
      {
        kind: "relationship",
        change: operation.kind === "link" ? "linked" : "unlinked",
        relationship: operation.relationship,
        source: source.value.key,
        target: target.value.key,
        changed,
      },
    ],
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
    const types = new Map<string, LinkableEntityType>();
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
  entity: VersionedEntityType,
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
    case "rule": {
      return await ruleRepository.findById(run.scope, id, run.tx);
    }
    case "milestone": {
      return await milestoneRepository.findById(run.scope, id, run.tx);
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
  diff: readonly SemanticDiff[],
): void {
  run.applied.push({
    index,
    operation,
    entity: entity.entity,
    key: entity.key,
    id: entity.id,
    revision: entity.revision,
    ref,
    diff,
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
