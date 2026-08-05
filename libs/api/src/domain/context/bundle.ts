import type { WorkspaceScope } from "../auth/workspaceScope";
import type { EntityType } from "../enums";
import { type DependencyRow, dependencyRepository } from "../repository/dependency";
import type { DbExecutor } from "../repository/entity";
import { streamRepository } from "../repository/stream";
import { type ZpecsDocument, parseDocument } from "../schema/document";

/**
 * The domain spec §7 context bundle (plan task B16).
 *
 * §7 says that when an agent reads a task, the server should be able to hand it the
 * relevant stream context as well: the stream purpose, the associated requirements,
 * the linked acceptance criteria, the relevant business rules and edge cases, and
 * the task's dependencies — "ohne dass die Daten redundant in jedem Task dupliziert
 * werden müssen".
 *
 * ## Projected, not duplicated
 *
 * Nothing here copies stream content into a second structure. The bundle *selects*
 * from the parent stream's own document and passes the selected sections through
 * verbatim, with the field names the document uses (`id`, `statement`,
 * `given`/`when`/`then`, `expected_behavior`). A remapped shape would be a second
 * definition of a requirement living next to the schema's, and the two would drift
 * the first time a section gains a field.
 *
 * ## Two queries, and why that is the floor
 *
 * Building this for a task costs **two** queries, whatever the size of the task:
 *
 * 1. the parent stream row — all five of §7's business sections come out of that
 *    one document, so referencing fifty requirements costs no more than referencing
 *    one;
 * 2. the dependency edges *with their endpoints already named* — one statement in
 *    `repository/dependency.ts`, whatever the number of edges.
 *
 * The naive implementation resolves each referenced requirement id and each linked
 * criterion id with its own lookup, and each dependency endpoint with another; on a
 * real stream that is dozens of round trips inside a single tool call. Keep this
 * projection at two queries regardless of referenced-list or dependency-graph
 * size.
 *
 * A stream or an epic subject costs **one** query: a stream is its own context, and
 * an epic has no stream context at all.
 *
 * ## What "relevant" means, per section
 *
 * - `requirements` and `acceptanceCriteria` are **filtered** to what the task's
 *   `content.implements` names — those are §7's "zugehörige Requirements" and
 *   "verknüpfte Acceptance Criteria". A criterion also counts as linked when its
 *   `verifies` list names one of the referenced requirements, because that is the
 *   only place in the model that records which criterion checks which requirement.
 * - `businessRules` and `edgeCases` are the parent stream's **in full**. Nothing in
 *   the model links a task to an individual business rule or edge case, so any
 *   narrower rule would be invented; what makes them relevant is that they
 *   constrain the stream this task implements.
 * - For a stream subject there is nothing to filter by, so every section is the
 *   stream's own.
 */

/**
 * The entity the bundle is built for. The caller has already loaded the row —
 * `get_context` has to return it either way, and re-reading it here would be a
 * third query for a document already in memory.
 */
export type BundleSubject =
  | {
      readonly entity: "epic";
      readonly id: string;
      readonly key: string;
      readonly title: string;
      readonly document: Record<string, unknown>;
    }
  | {
      readonly entity: "stream";
      readonly id: string;
      readonly key: string;
      readonly title: string;
      readonly document: Record<string, unknown>;
    }
  | {
      readonly entity: "task";
      readonly id: string;
      readonly key: string;
      readonly title: string;
      /** The `stream_id` column, not `links.parent_stream_id` — the column is the row id. */
      readonly streamId: string;
      readonly document: Record<string, unknown>;
    };

/* The projected section types, taken from the stream document rather than restated.
   Reading them off a narrowing function is what keeps them tied to the schema: the
   content union has four members and only the `feature` one declares requirements
   and acceptance criteria, so `in` is how both the types and the values are got. */

/**
 * The parsed documents, addressed through `ZpecsDocument` rather than through the
 * stored-tier aliases. `parseDocument` returns the union of both tiers whatever
 * `source` was asked for, and the two tiers differ only in `meta` — the content
 * types are the same objects — so narrowing on `entity` is enough to reach every
 * section this file reads.
 */
type ParsedStream = Extract<ZpecsDocument, { entity: "stream" }>;
type ParsedTask = Extract<ZpecsDocument, { entity: "task" }>;
type StreamContent = ParsedStream["content"];
type TaskContent = ParsedTask["content"];

const requirementsOf = (content: StreamContent) =>
  "requirements" in content ? content.requirements : undefined;
const acceptanceCriteriaOf = (content: StreamContent) =>
  "acceptance_criteria" in content ? content.acceptance_criteria : undefined;

type StreamRequirements = NonNullable<ReturnType<typeof requirementsOf>>;
export type FunctionalRequirement = NonNullable<StreamRequirements["functional"]>[number];
export type NonFunctionalRequirement = NonNullable<StreamRequirements["non_functional"]>[number];
export type AcceptanceCriterion = NonNullable<ReturnType<typeof acceptanceCriteriaOf>>[number];
export type BusinessRule = NonNullable<StreamContent["business_rules"]>[number];
export type EdgeCase = NonNullable<StreamContent["edge_cases"]>[number];

/** The other end of one dependency edge, named. */
export type BundleDependency = {
  readonly entity: EntityType;
  readonly key: string;
  readonly title: string;
  readonly status: string;
  readonly reason: string | null;
};

export type ContextBundle = {
  /** The stream that supplies the business context; `null` for an epic. */
  readonly stream: {
    readonly key: string;
    readonly title: string;
    /** `null` only when the stored document does not parse — see `emptyStreamSections`. */
    readonly purpose: string | null;
  } | null;
  readonly requirements: {
    readonly functional: readonly FunctionalRequirement[];
    readonly nonFunctional: readonly NonFunctionalRequirement[];
  };
  readonly acceptanceCriteria: readonly AcceptanceCriterion[];
  readonly businessRules: readonly BusinessRule[];
  readonly edgeCases: readonly EdgeCase[];
  readonly dependencies: {
    /** Entities that must be finished first. */
    readonly blockedBy: readonly BundleDependency[];
    /** Entities waiting on this one. Same stored edges, read from the other side. */
    readonly blocks: readonly BundleDependency[];
  };
  /**
   * Ids named by the task's `content.implements` that the parent stream does not
   * define. Reported rather than dropped: an empty `requirements` list is otherwise
   * indistinguishable from "this task references nothing", and a task pointing at a
   * requirement that was renamed or removed is exactly the §11
   * `referenced_ids_must_exist` violation the service layer is supposed to surface.
   */
  readonly unresolvedReferences: readonly string[];
};

type StreamSections = Pick<
  ContextBundle,
  "requirements" | "acceptanceCriteria" | "businessRules" | "edgeCases" | "unresolvedReferences"
>;

const emptyStreamSections = (): StreamSections => ({
  requirements: { functional: [], nonFunctional: [] },
  acceptanceCriteria: [],
  businessRules: [],
  edgeCases: [],
  unresolvedReferences: [],
});

/**
 * `parseDocument` is the only way into the schema layer, and a read path must not
 * fall over on a document it cannot validate — `null` degrades the bundle to what
 * the relational columns already say.
 */
const storedStream = (document: Record<string, unknown>): ParsedStream | null => {
  const result = parseDocument(document, { source: "store" });
  return result.ok && result.document.entity === "stream" ? result.document : null;
};

const storedTask = (document: Record<string, unknown>): ParsedTask | null => {
  const result = parseDocument(document, { source: "store" });
  return result.ok && result.document.entity === "task" ? result.document : null;
};

/**
 * Selects the sections of one stream document that matter for `references`.
 *
 * Pure, and exported so the selection rules can be tested without a database — they
 * are the part of the bundle that carries a decision, while everything around them
 * is two queries and a grouping.
 *
 * `references === null` means "no filter": the subject *is* this stream, so all of
 * its own sections are its context.
 */
export const projectStreamSections = (
  content: StreamContent,
  references: {
    readonly requirementIds: readonly string[];
    readonly acceptanceCriteriaIds: readonly string[];
  } | null,
): StreamSections => {
  const allFunctional = requirementsOf(content)?.functional ?? [];
  const allNonFunctional = requirementsOf(content)?.non_functional ?? [];
  const allCriteria = acceptanceCriteriaOf(content) ?? [];
  const businessRules = content.business_rules ?? [];
  const edgeCases = content.edge_cases ?? [];

  if (references === null) {
    return {
      requirements: { functional: allFunctional, nonFunctional: allNonFunctional },
      acceptanceCriteria: allCriteria,
      businessRules,
      edgeCases,
      unresolvedReferences: [],
    };
  }

  const wantedRequirements = new Set(references.requirementIds);
  const wantedCriteria = new Set(references.acceptanceCriteriaIds);
  const functional = allFunctional.filter((item) => wantedRequirements.has(item.id));
  const nonFunctional = allNonFunctional.filter((item) => wantedRequirements.has(item.id));
  // A criterion is linked either because the task named it, or because it verifies
  // one of the requirements the task implements. The second half is what makes the
  // `verifies` list on a criterion mean something on the read path.
  const acceptanceCriteria = allCriteria.filter(
    (item) =>
      wantedCriteria.has(item.id) ||
      (item.verifies ?? []).some((verified) => wantedRequirements.has(verified)),
  );

  const resolved = new Set<string>([
    ...functional.map((item) => item.id),
    ...nonFunctional.map((item) => item.id),
    ...acceptanceCriteria.map((item) => item.id),
  ]);
  const unresolvedReferences = [...wantedRequirements, ...wantedCriteria].filter(
    (id) => !resolved.has(id),
  );

  return {
    requirements: { functional, nonFunctional },
    acceptanceCriteria,
    businessRules,
    edgeCases,
    unresolvedReferences,
  };
};

const toDependency = (row: DependencyRow): BundleDependency => ({
  entity: row.entity,
  key: row.key,
  title: row.title,
  status: row.status,
  reason: row.reason,
});

const groupDependencies = (rows: readonly DependencyRow[]): ContextBundle["dependencies"] => ({
  blockedBy: rows.filter((row) => row.direction === "blocked_by").map(toDependency),
  blocks: rows.filter((row) => row.direction === "blocks").map(toDependency),
});

type SectionReferences = {
  readonly requirementIds: readonly string[];
  readonly acceptanceCriteriaIds: readonly string[];
};

/** What the task's `content.implements` names. Nothing named is an empty filter, not no filter. */
const referencesOf = (content: TaskContent | null): SectionReferences => ({
  requirementIds: content?.implements?.requirement_ids ?? [],
  acceptanceCriteriaIds: content?.implements?.acceptance_criteria_ids ?? [],
});

/**
 * Assembles the §7 bundle for one already-loaded entity.
 *
 * Two queries for a task, one for a stream or an epic. See the file comment for why
 * that is the design constraint rather than an implementation detail.
 */
export async function buildContextBundle(
  scope: WorkspaceScope,
  subject: BundleSubject,
  executor?: DbExecutor,
): Promise<ContextBundle> {
  const dependencyRows = dependencyRepository.forEntity(
    scope,
    { entity: subject.entity, id: subject.id },
    executor,
  );

  if (subject.entity === "epic") {
    return {
      stream: null,
      ...emptyStreamSections(),
      dependencies: groupDependencies(await dependencyRows),
    };
  }

  if (subject.entity === "stream") {
    const document = storedStream(subject.document);
    return {
      stream: {
        key: subject.key,
        title: subject.title,
        purpose: document?.content.purpose ?? null,
      },
      ...(document === null
        ? emptyStreamSections()
        : projectStreamSections(document.content, null)),
      dependencies: groupDependencies(await dependencyRows),
    };
  }

  const parentStream = await streamRepository.findById(scope, subject.streamId, executor);
  if (parentStream === null) {
    // Not reachable through a consistent database — `task.stream_id` is a
    // cascading foreign key — but it is reachable across a tenant boundary, and
    // answering "no stream context" is the right answer there.
    return {
      stream: null,
      ...emptyStreamSections(),
      dependencies: groupDependencies(await dependencyRows),
    };
  }

  const streamDocument = storedStream(parentStream.document);
  const references = referencesOf(storedTask(subject.document)?.content ?? null);

  return {
    stream: {
      key: parentStream.key,
      title: parentStream.title,
      purpose: streamDocument?.content.purpose ?? null,
    },
    ...(streamDocument === null
      ? emptyStreamSections()
      : projectStreamSections(streamDocument.content, references)),
    dependencies: groupDependencies(await dependencyRows),
  };
}
