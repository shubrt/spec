import type { WorkspaceScope } from "../auth/workspaceScope";
import type { DependencyEndpointType } from "../enums";
import { type DependencyRow, dependencyRepository } from "../repository/dependency";
import { type DbExecutor, findRevisionDocument } from "../repository/entity";
import { epicRepository } from "../repository/epic";
import { type MilestoneStream, milestoneRepository } from "../repository/milestone";
import { type EntityRelation, relationRepository } from "../repository/relation";
import { type RuleConsumer, ruleRepository } from "../repository/rule";
import { streamRepository } from "../repository/stream";
import { type SpecDocument, parseDocument } from "../schema/document";
import {
  deriveSourceFreshness,
  relevantSources,
  type SourceFreshness,
} from "../schema/sourceFreshness";
import { PRE_V2_TRACE_NOT_RECORDED } from "../schema/task/content";
import {
  type ResolvedContextRules,
  acceptanceCriterionRuleUses,
  applicationRuleUses,
  resolveContextRules,
  taskConstraintRuleUses,
  taskPinRuleUses,
} from "./rules";

/**
 * The domain spec §7 context bundle (plan task B16).
 *
 * §7 says that when an agent reads a task, the server should be able to hand it the
 * relevant stream context as well: the stream purpose, its typed business targets,
 * linked acceptance criteria, Rule applications, constraints and dependencies —
 * without duplicating those definitions into every Task.
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
 * ## Fixed query count
 *
 * Parent documents, dependencies, soft relations, Rules and roadmap context are
 * each loaded in one bounded query and independent reads run in parallel. The
 * count therefore depends on the entity kind, never on the number of referenced
 * targets, Rules or graph edges. Do not replace these projections with per-id
 * lookups.
 *
 * ## What "relevant" means, per section
 *
 * - Typed targets and acceptance criteria are **filtered** to what the Task's
 *   `content.implements` names. A criterion also counts as linked when its typed
 *   `verifies.requirement_ids` names a referenced Requirement.
 * - `ruleApplications`, `edgeCases` and maintenance risks are the parent Stream's
 *   **in full** because they constrain the Stream rather than satisfying Task
 *   readiness.
 * - For a stream subject there is nothing to filter by, so every section is the
 *   stream's own.
 */

/**
 * The entity the bundle is built for. The caller has already loaded the row —
 * `get_context` has to return it either way, and re-reading it here would be a
 * third query for a document already in memory.
 */
type BundleSubjectBase = {
  readonly id: string;
  readonly key: string;
  readonly title: string;
  readonly status: string;
  readonly revision: number;
  readonly projectId: string;
  readonly document: Record<string, unknown>;
};

export type BundleSubject = BundleSubjectBase &
  (
    | {
        readonly entity: "epic";
        readonly epicId?: never;
        readonly streamId?: never;
        readonly roadmapOrder?: never;
      }
    | {
        readonly entity: "stream";
        readonly epicId: string;
        readonly milestoneId: string | null;
        readonly roadmapRank: number | null;
        readonly streamId?: never;
        readonly roadmapOrder?: never;
      }
    | {
        readonly entity: "task";
        /** The `stream_id` column, not `links.parent_stream_id` — the column is the row id. */
        readonly streamId: string;
        readonly epicId?: never;
        readonly roadmapOrder?: never;
      }
    | {
        readonly entity: "rule";
        readonly epicId?: never;
        readonly streamId?: never;
        readonly roadmapOrder?: never;
      }
    | {
        readonly entity: "milestone";
        readonly roadmapOrder: number;
        readonly epicId?: never;
        readonly streamId?: never;
      }
  );

/* The projected section types, taken from the stream document rather than restated.
   Reading them off a narrowing function is what keeps them tied to the schema: the
   content union has four members and only the `feature` one declares requirements
   and acceptance criteria, so `in` is how both the types and the values are got. */

/**
 * The parsed documents, addressed through `SpecDocument` rather than through the
 * stored-tier aliases. `parseDocument` returns the union of both tiers whatever
 * `source` was asked for, and the two tiers differ only in `meta` — the content
 * types are the same objects — so narrowing on `entity` is enough to reach every
 * section this file reads.
 */
type ParsedEpic = Extract<SpecDocument, { entity: "epic" }>;
type ParsedStream = Extract<SpecDocument, { entity: "stream" }>;
type ParsedTask = Extract<SpecDocument, { entity: "task" }>;
type ParsedRule = Extract<SpecDocument, { entity: "rule" }>;
type ParsedMilestone = Extract<SpecDocument, { entity: "milestone" }>;
type ParsedVersioned = ParsedEpic | ParsedStream | ParsedTask | ParsedRule | ParsedMilestone;
type ProvenanceSource = NonNullable<ParsedVersioned["provenance"]["sources"]>[number];
type ProjectedSource = ProvenanceSource & { readonly freshness: SourceFreshness };
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
export type RuleApplication = NonNullable<StreamContent["rule_applications"]>[number];
export type EdgeCase = NonNullable<StreamContent["edge_cases"]>[number];

type ArrayItemAt<Content, Key extends PropertyKey> = Content extends unknown
  ? Key extends keyof Content
    ? NonNullable<Content[Key]> extends readonly (infer Item)[]
      ? Item
      : never
    : never
  : never;

export type BehaviorCase = ArrayItemAt<StreamContent, "behavior_cases">;
export type ChangeTarget = ArrayItemAt<StreamContent, "changes">;
export type ExperimentHypothesis = ArrayItemAt<StreamContent, "hypotheses">;
export type ResearchQuestion = ArrayItemAt<StreamContent, "research_questions">;
export type SuccessCriterion = ArrayItemAt<StreamContent, "success_criteria">;
export type DecisionRule = ArrayItemAt<StreamContent, "decision_rules">;
export type InvestigationQuestion = ArrayItemAt<StreamContent, "questions">;
export type RefactorTarget = ArrayItemAt<StreamContent, "refactor_targets">;
export type RefactorInvariant = ArrayItemAt<StreamContent, "invariants">;
export type QualityGoal = ArrayItemAt<StreamContent, "quality_goals">;
export type MaintenanceGoal = ArrayItemAt<StreamContent, "maintenance_goals">;
export type MaintenanceRisk = ArrayItemAt<StreamContent, "risks">;

/** The other end of one dependency edge, named. */
export type BundleDependency = {
  readonly entity: DependencyEndpointType;
  readonly key: string;
  readonly title: string;
  readonly status: string;
  readonly reason: string | null;
};

export type HierarchyContextBundle = {
  readonly kind: "hierarchy";
  /** A Stream's own sections already exist in the returned document and are not repeated. */
  readonly sectionsOmittedAsDocumentDuplicate: boolean;
  /** The stream that supplies the business context; `null` for an epic. */
  readonly stream: {
    readonly key: string;
    /** `null` when no truthful historical Stream document is available. */
    readonly title: string | null;
    readonly revision: number | null;
    readonly revisionSource:
      | "current"
      | "task_started"
      | "task_used"
      | "missing_task_started"
      | "missing_task_used"
      | "not_recorded"
      | "not_applicable";
    /** `null` when the selected snapshot is missing or does not parse. */
    readonly purpose: string | null;
  } | null;
  readonly milestone: {
    readonly key: string;
    readonly title: string;
    readonly status: string;
    readonly roadmapOrder: number;
    readonly streamRank: number | null;
  } | null;
  readonly requirements: {
    readonly functional: readonly FunctionalRequirement[];
    readonly nonFunctional: readonly NonFunctionalRequirement[];
  };
  readonly acceptanceCriteria: readonly AcceptanceCriterion[];
  readonly targets: {
    readonly behaviorCases: readonly BehaviorCase[];
    readonly changes: readonly ChangeTarget[];
    readonly hypotheses: readonly ExperimentHypothesis[];
    readonly researchQuestions: readonly ResearchQuestion[];
    readonly successCriteria: readonly SuccessCriterion[];
    readonly decisionRules: readonly DecisionRule[];
    readonly investigationQuestions: readonly InvestigationQuestion[];
    readonly refactorTargets: readonly RefactorTarget[];
    readonly invariants: readonly RefactorInvariant[];
    readonly qualityGoals: readonly QualityGoal[];
    readonly maintenanceGoals: readonly MaintenanceGoal[];
    /** Constraints projected in full; RSK ids are deliberately not Task targets. */
    readonly risks: readonly MaintenanceRisk[];
  };
  readonly ruleApplications: readonly RuleApplication[];
  readonly edgeCases: readonly EdgeCase[];
  /** Local SRC ids are meaningful only together with the document that owns them. */
  readonly evidenceSources: readonly {
    readonly owner: {
      readonly entity: "epic" | "stream" | "task";
      readonly key: string;
      readonly revision: number;
    };
    readonly sources: readonly ProjectedSource[];
  }[];
  readonly dependencies: {
    /** Entities that must be finished first. */
    readonly blockedBy: readonly BundleDependency[];
    /** Entities waiting on this one. Same stored edges, read from the other side. */
    readonly blocks: readonly BundleDependency[];
  };
  /** Non-blocking graph relations. Hard blockers stay in `dependencies`. */
  readonly relations: readonly EntityRelation[];
  /** Canonical definitions are deduplicated; `uses` preserves every local source. */
  readonly rules: ResolvedContextRules;
  /**
   * Ids named by the task's `content.implements` that the parent stream does not
   * define. Reported rather than dropped: an empty `requirements` list is otherwise
   * indistinguishable from "this task references nothing", and a task pointing at a
   * requirement that was renamed or removed is exactly the §11
   * `referenced_ids_must_exist` violation the service layer is supposed to surface.
   */
  readonly unresolvedReferences: readonly string[];
};

export type RuleContextBundle = {
  readonly kind: "rule";
  /** Direct consumers only; inherited descendants are represented by their ancestor application. */
  readonly consumers: readonly RuleConsumer[];
  readonly relations: readonly EntityRelation[];
  readonly sources: readonly ProjectedSource[];
};

export type MilestoneContextBundle = {
  readonly kind: "milestone";
  readonly roadmapOrder: number;
  readonly streams: readonly MilestoneStream[];
  readonly sources: readonly ProjectedSource[];
};

export type ContextBundle = HierarchyContextBundle | RuleContextBundle | MilestoneContextBundle;

type StreamSections = Pick<
  HierarchyContextBundle,
  | "requirements"
  | "acceptanceCriteria"
  | "targets"
  | "ruleApplications"
  | "edgeCases"
  | "unresolvedReferences"
>;

const emptyStreamSections = (): StreamSections => ({
  requirements: { functional: [], nonFunctional: [] },
  acceptanceCriteria: [],
  targets: {
    behaviorCases: [],
    changes: [],
    hypotheses: [],
    researchQuestions: [],
    successCriteria: [],
    decisionRules: [],
    investigationQuestions: [],
    refactorTargets: [],
    invariants: [],
    qualityGoals: [],
    maintenanceGoals: [],
    risks: [],
  },
  ruleApplications: [],
  edgeCases: [],
  unresolvedReferences: [],
});

const evidenceCatalog = (
  entity: "epic" | "stream" | "task",
  key: string,
  revision: number,
  document: ParsedEpic | ParsedStream | ParsedTask | null,
  projectedClaims: unknown,
): HierarchyContextBundle["evidenceSources"][number] | null => {
  const sources = document?.provenance.sources ?? [];
  const projected = relevantSources(sources, projectedClaims);
  if (projected.length === 0) return null;
  const freshness = deriveSourceFreshness(sources);
  return {
    owner: { entity, key, revision },
    sources: projected.map((source) => ({
      ...source,
      freshness: freshness.get(source.id) ?? "unknown",
    })),
  };
};

const projectedSources = (document: ParsedVersioned | null): readonly ProjectedSource[] => {
  const sources = document?.provenance.sources ?? [];
  const projected = relevantSources(sources, document?.content);
  const freshness = deriveSourceFreshness(sources);
  return projected.map((source) => ({
    ...source,
    freshness: freshness.get(source.id) ?? "unknown",
  }));
};

const catalogs = (
  ...values: readonly (HierarchyContextBundle["evidenceSources"][number] | null)[]
): HierarchyContextBundle["evidenceSources"] => values.filter((value) => value !== null);

/**
 * `parseDocument` is the only way into the schema layer, and a read path must not
 * fall over on a document it cannot validate — `null` degrades the bundle to what
 * the relational columns already say.
 */
const storedEpic = (document: Record<string, unknown>): ParsedEpic | null => {
  const result = parseDocument(document, { source: "store" });
  return result.ok && result.document.entity === "epic" ? result.document : null;
};

const storedStream = (document: Record<string, unknown>): ParsedStream | null => {
  const result = parseDocument(document, { source: "store" });
  return result.ok && result.document.entity === "stream" ? result.document : null;
};

const storedTask = (document: Record<string, unknown>): ParsedTask | null => {
  const result = parseDocument(document, { source: "store" });
  return result.ok && result.document.entity === "task" ? result.document : null;
};

const storedRule = (document: Record<string, unknown>): ParsedRule | null => {
  const result = parseDocument(document, { source: "store" });
  return result.ok && result.document.entity === "rule" ? result.document : null;
};

const storedMilestone = (document: Record<string, unknown>): ParsedMilestone | null => {
  const result = parseDocument(document, { source: "store" });
  return result.ok && result.document.entity === "milestone" ? result.document : null;
};

type SectionReferences = {
  readonly requirementIds: readonly string[];
  readonly acceptanceCriteriaIds: readonly string[];
  readonly behaviorCaseIds: readonly string[];
  readonly changeIds: readonly string[];
  readonly hypothesisIds: readonly string[];
  readonly researchQuestionIds: readonly string[];
  readonly successCriteriaIds: readonly string[];
  readonly decisionRuleIds: readonly string[];
  readonly investigationQuestionIds: readonly string[];
  readonly refactorTargetIds: readonly string[];
  readonly invariantIds: readonly string[];
  readonly qualityGoalIds: readonly string[];
  readonly maintenanceGoalIds: readonly string[];
};

const itemsOf = <Key extends string>(
  content: StreamContent,
  key: Key,
): readonly ArrayItemAt<StreamContent, Key>[] => {
  const value = (content as unknown as Record<string, unknown>)[key];
  return (Array.isArray(value) ? value : []) as readonly ArrayItemAt<StreamContent, Key>[];
};

const selectedById = <Item extends { readonly id: string }>(
  items: readonly Item[],
  ids: readonly string[],
): readonly Item[] => {
  const wanted = new Set(ids);
  return items.filter((item) => wanted.has(item.id));
};

/**
 * Selects the sections of one Stream document that matter for `references`.
 * `references === null` means the subject is the Stream itself, so no target is
 * filtered. The function is pure; database work around it remains constant-size.
 */
export const projectStreamSections = (
  content: StreamContent,
  references: SectionReferences | null,
): StreamSections => {
  const allFunctional = requirementsOf(content)?.functional ?? [];
  const allNonFunctional = requirementsOf(content)?.non_functional ?? [];
  const allCriteria = acceptanceCriteriaOf(content) ?? [];
  const allTargets = {
    behaviorCases: itemsOf(content, "behavior_cases"),
    changes: itemsOf(content, "changes"),
    hypotheses: itemsOf(content, "hypotheses"),
    researchQuestions: itemsOf(content, "research_questions"),
    successCriteria: itemsOf(content, "success_criteria"),
    decisionRules: itemsOf(content, "decision_rules"),
    investigationQuestions: itemsOf(content, "questions"),
    refactorTargets: itemsOf(content, "refactor_targets"),
    invariants: itemsOf(content, "invariants"),
    qualityGoals: itemsOf(content, "quality_goals"),
    maintenanceGoals: itemsOf(content, "maintenance_goals"),
    risks: itemsOf(content, "risks"),
  };
  const ruleApplications = content.rule_applications ?? [];
  const edgeCases = content.edge_cases ?? [];

  if (references === null) {
    return {
      requirements: { functional: allFunctional, nonFunctional: allNonFunctional },
      acceptanceCriteria: allCriteria,
      targets: allTargets,
      ruleApplications,
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
  // typed `verifies.requirement_ids` list meaningful on the read path.
  const acceptanceCriteria = allCriteria.filter(
    (item) =>
      wantedCriteria.has(item.id) ||
      (item.verifies?.requirement_ids ?? []).some((verified) => wantedRequirements.has(verified)),
  );

  const targets = {
    behaviorCases: selectedById(allTargets.behaviorCases, references.behaviorCaseIds),
    changes: selectedById(allTargets.changes, references.changeIds),
    hypotheses: selectedById(allTargets.hypotheses, references.hypothesisIds),
    researchQuestions: selectedById(allTargets.researchQuestions, references.researchQuestionIds),
    successCriteria: selectedById(allTargets.successCriteria, references.successCriteriaIds),
    decisionRules: selectedById(allTargets.decisionRules, references.decisionRuleIds),
    investigationQuestions: selectedById(
      allTargets.investigationQuestions,
      references.investigationQuestionIds,
    ),
    refactorTargets: selectedById(allTargets.refactorTargets, references.refactorTargetIds),
    invariants: selectedById(allTargets.invariants, references.invariantIds),
    qualityGoals: selectedById(allTargets.qualityGoals, references.qualityGoalIds),
    maintenanceGoals: selectedById(allTargets.maintenanceGoals, references.maintenanceGoalIds),
    risks: allTargets.risks,
  };

  const resolved = new Set<string>([
    ...functional.map((item) => item.id),
    ...nonFunctional.map((item) => item.id),
    ...acceptanceCriteria.map((item) => item.id),
    ...targets.behaviorCases.map((item) => item.id),
    ...targets.changes.map((item) => item.id),
    ...targets.hypotheses.map((item) => item.id),
    ...targets.researchQuestions.map((item) => item.id),
    ...targets.successCriteria.map((item) => item.id),
    ...targets.decisionRules.map((item) => item.id),
    ...targets.investigationQuestions.map((item) => item.id),
    ...targets.refactorTargets.map((item) => item.id),
    ...targets.invariants.map((item) => item.id),
    ...targets.qualityGoals.map((item) => item.id),
    ...targets.maintenanceGoals.map((item) => item.id),
  ]);
  const unresolvedReferences = [
    ...wantedRequirements,
    ...wantedCriteria,
    ...references.behaviorCaseIds,
    ...references.changeIds,
    ...references.hypothesisIds,
    ...references.researchQuestionIds,
    ...references.successCriteriaIds,
    ...references.decisionRuleIds,
    ...references.investigationQuestionIds,
    ...references.refactorTargetIds,
    ...references.invariantIds,
    ...references.qualityGoalIds,
    ...references.maintenanceGoalIds,
  ].filter((id) => !resolved.has(id));

  return {
    requirements: { functional, nonFunctional },
    acceptanceCriteria,
    targets,
    ruleApplications,
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

const groupDependencies = (
  rows: readonly DependencyRow[],
): HierarchyContextBundle["dependencies"] => ({
  blockedBy: rows.filter((row) => row.direction === "blocked_by").map(toDependency),
  blocks: rows.filter((row) => row.direction === "blocks").map(toDependency),
});

/** What the task's `content.implements` names. Nothing named is an empty filter, not no filter. */
const referencesOf = (content: TaskContent | null): SectionReferences => ({
  requirementIds: content?.implements?.requirement_ids ?? [],
  acceptanceCriteriaIds: content?.implements?.acceptance_criteria_ids ?? [],
  behaviorCaseIds: content?.implements?.behavior_case_ids ?? [],
  changeIds: content?.implements?.change_ids ?? [],
  hypothesisIds: content?.implements?.hypothesis_ids ?? [],
  researchQuestionIds: content?.implements?.research_question_ids ?? [],
  successCriteriaIds: content?.implements?.success_criteria_ids ?? [],
  decisionRuleIds: content?.implements?.decision_rule_ids ?? [],
  investigationQuestionIds: content?.implements?.investigation_question_ids ?? [],
  refactorTargetIds: content?.implements?.refactor_target_ids ?? [],
  invariantIds: content?.implements?.invariant_ids ?? [],
  qualityGoalIds: content?.implements?.quality_goal_ids ?? [],
  maintenanceGoalIds: content?.implements?.maintenance_goal_ids ?? [],
});

/**
 * Assembles the §7 bundle for one already-loaded entity.
 *
 * Every collection is batch-loaded; query count is fixed by subject kind rather
 * than by the number of references or relationships.
 */
export async function buildContextBundle(
  scope: WorkspaceScope,
  subject: BundleSubject,
  executor?: DbExecutor,
): Promise<ContextBundle> {
  if (subject.entity === "rule") {
    const [consumers, relations] = await Promise.all([
      ruleRepository.listConsumers(
        scope,
        { projectId: subject.projectId, ruleKey: subject.key },
        executor,
      ),
      relationRepository.forEntity(
        scope,
        { projectId: subject.projectId, entity: "rule", id: subject.id },
        executor,
      ),
    ]);
    return {
      kind: "rule",
      consumers,
      relations,
      sources: projectedSources(storedRule(subject.document)),
    };
  }

  if (subject.entity === "milestone") {
    return {
      kind: "milestone",
      roadmapOrder: subject.roadmapOrder,
      streams: await milestoneRepository.listAssignedStreams(scope, subject.id, executor),
      sources: projectedSources(storedMilestone(subject.document)),
    };
  }

  if (subject.entity === "epic") {
    const document = storedEpic(subject.document);
    const uses = applicationRuleUses(
      document?.content.rule_applications ?? [],
      { entity: "epic", key: subject.key },
      false,
    );
    const [dependencies, relations, rules] = await Promise.all([
      Promise.resolve<readonly DependencyRow[]>([]),
      relationRepository.forEntity(
        scope,
        { projectId: subject.projectId, entity: "epic", id: subject.id },
        executor,
      ),
      resolveContextRules(scope, { projectId: subject.projectId, uses }, executor),
    ]);
    return {
      kind: "hierarchy",
      sectionsOmittedAsDocumentDuplicate: false,
      stream: null,
      milestone: null,
      ...emptyStreamSections(),
      evidenceSources: catalogs(
        evidenceCatalog("epic", subject.key, subject.revision, document, document?.content),
      ),
      dependencies: groupDependencies(dependencies),
      relations,
      rules,
    };
  }

  const dependencyRows = dependencyRepository.forEntity(
    scope,
    { entity: subject.entity, id: subject.id },
    executor,
  );
  const relationRows = relationRepository.forEntity(
    scope,
    { projectId: subject.projectId, entity: subject.entity, id: subject.id },
    executor,
  );

  if (subject.entity === "stream") {
    const document = storedStream(subject.document);
    const [dependencies, relations, parentEpic, assignedMilestone] = await Promise.all([
      dependencyRows,
      relationRows,
      epicRepository.findById(scope, subject.epicId, executor),
      subject.milestoneId === null
        ? Promise.resolve(null)
        : milestoneRepository.findById(scope, subject.milestoneId, executor),
    ]);
    const sections =
      document === null ? emptyStreamSections() : projectStreamSections(document.content, null);
    const epicDocument = parentEpic === null ? null : storedEpic(parentEpic.document);
    const uses = [
      ...applicationRuleUses(
        epicDocument?.content.rule_applications ?? [],
        { entity: "epic", key: parentEpic?.key ?? "" },
        true,
      ),
      ...applicationRuleUses(
        document?.content.rule_applications ?? [],
        { entity: "stream", key: subject.key },
        false,
      ),
      ...acceptanceCriterionRuleUses(sections.acceptanceCriteria, subject.key, false),
    ];
    const rules = await resolveContextRules(
      scope,
      { projectId: subject.projectId, uses },
      executor,
    );
    return {
      kind: "hierarchy",
      sectionsOmittedAsDocumentDuplicate: true,
      stream: {
        key: subject.key,
        title: subject.title,
        revision: subject.revision,
        revisionSource: "current",
        purpose: document?.content.purpose ?? null,
      },
      milestone:
        assignedMilestone === null
          ? null
          : {
              key: assignedMilestone.key,
              title: assignedMilestone.title,
              status: assignedMilestone.status,
              roadmapOrder: assignedMilestone.roadmapOrder,
              streamRank: subject.roadmapRank,
            },
      ...emptyStreamSections(),
      evidenceSources: catalogs(
        evidenceCatalog(
          "epic",
          parentEpic?.key ?? "",
          parentEpic?.revision ?? 0,
          epicDocument,
          uses.filter((use) => use.source === "epic_application"),
        ),
        evidenceCatalog("stream", subject.key, subject.revision, document, sections),
      ),
      dependencies: groupDependencies(dependencies),
      relations,
      rules,
    };
  }

  const taskDocument = storedTask(subject.document);
  const [dependencies, relations, parentStream] = await Promise.all([
    dependencyRows,
    relationRows,
    streamRepository.findById(scope, subject.streamId, executor),
  ]);
  const execution = taskDocument?.execution;
  const usedStream =
    execution !== undefined && "stream_revision_used" in execution
      ? execution.stream_revision_used
      : undefined;
  const startedStreamRevision =
    execution !== undefined && "stream_revision_started" in execution
      ? execution.stream_revision_started
      : undefined;
  const preV2TraceNotRecorded =
    execution !== undefined &&
    "trace_state" in execution &&
    execution.trace_state === PRE_V2_TRACE_NOT_RECORDED;
  const terminal = subject.status === "done" || subject.status === "cancelled";
  const requestedStreamRevision = preV2TraceNotRecorded
    ? undefined
    : terminal
      ? usedStream?.revision
      : startedStreamRevision;
  const requestedSource = terminal ? "task_used" : "task_started";
  const expectsRecordedSnapshot =
    terminal ||
    subject.status === "in_progress" ||
    subject.status === "blocked" ||
    subject.status === "in_review";
  const traceNotApplicable =
    !preV2TraceNotRecorded &&
    subject.status === "cancelled" &&
    usedStream === undefined &&
    startedStreamRevision === undefined;
  const currentIsRequested =
    parentStream !== null && requestedStreamRevision === parentStream.revision;
  const streamSnapshot =
    parentStream !== null && requestedStreamRevision !== undefined && !currentIsRequested
      ? await findRevisionDocument(
          scope,
          { entity: "stream", id: parentStream.id, revision: requestedStreamRevision },
          executor,
        )
      : null;
  const requestedDocument = currentIsRequested ? parentStream?.document : streamSnapshot;
  const parsedRequestedDocument =
    requestedDocument === null || requestedDocument === undefined
      ? null
      : storedStream(requestedDocument);
  const streamRevisionSource: NonNullable<HierarchyContextBundle["stream"]>["revisionSource"] =
    parentStream === null
      ? "current"
      : preV2TraceNotRecorded
        ? "not_recorded"
        : requestedStreamRevision === undefined
          ? traceNotApplicable
            ? "not_applicable"
            : expectsRecordedSnapshot
              ? "not_recorded"
              : "current"
          : parsedRequestedDocument === null
            ? requestedSource === "task_used"
              ? "missing_task_used"
              : "missing_task_started"
            : requestedSource;
  const streamDocument =
    parentStream === null ||
    streamRevisionSource === "not_recorded" ||
    streamRevisionSource === "not_applicable"
      ? null
      : streamRevisionSource === "current"
        ? storedStream(parentStream.document)
        : parsedRequestedDocument;
  const streamRevision =
    parentStream === null
      ? null
      : streamRevisionSource === "current"
        ? parentStream.revision
        : (requestedStreamRevision ?? null);
  const references = referencesOf(taskDocument?.content ?? null);
  const sections =
    streamDocument === null
      ? emptyStreamSections()
      : projectStreamSections(streamDocument.content, references);
  const [parentEpic, assignedMilestone] =
    parentStream === null
      ? [null, null]
      : await Promise.all([
          epicRepository.findById(scope, parentStream.epicId, executor),
          parentStream.milestoneId === null
            ? Promise.resolve(null)
            : milestoneRepository.findById(scope, parentStream.milestoneId, executor),
        ]);
  const epicDocument = parentEpic === null ? null : storedEpic(parentEpic.document);
  const storedPins =
    !preV2TraceNotRecorded && execution !== undefined && "rule_revisions_used" in execution
      ? (execution.rule_revisions_used ?? [])
      : [];
  const pins = terminal
    ? storedPins.map((pin) => ({
        key: pin.rule_key,
        revision: pin.revision,
      }))
    : [];
  const uses = [
    // A terminal Task pins the exact effective Rule keys and revisions, but it
    // does not pin an Epic revision. Projecting today's Epic applications would
    // therefore make a Rule added later look historical. The task_pin uses below
    // remain the truthful source for Epic-inherited Rules at completion.
    ...(terminal
      ? []
      : applicationRuleUses(
          epicDocument?.content.rule_applications ?? [],
          { entity: "epic", key: parentEpic?.key ?? "" },
          true,
        )),
    ...applicationRuleUses(
      streamDocument?.content.rule_applications ?? [],
      { entity: "stream", key: parentStream?.key ?? "" },
      true,
    ),
    ...acceptanceCriterionRuleUses(sections.acceptanceCriteria, parentStream?.key ?? "", true),
    ...taskConstraintRuleUses(taskDocument?.content.constrained_by_rule_keys ?? [], subject.key),
    ...taskPinRuleUses(pins, subject.key),
  ];
  const rules = await resolveContextRules(
    scope,
    { projectId: subject.projectId, uses, pins, requirePins: terminal },
    executor,
  );

  return {
    kind: "hierarchy",
    sectionsOmittedAsDocumentDuplicate: false,
    stream:
      parentStream === null
        ? null
        : {
            key: parentStream.key,
            title:
              streamDocument?.meta.title ??
              (streamRevisionSource === "current" ? parentStream.title : null),
            revision: streamRevision,
            revisionSource: streamRevisionSource,
            purpose: streamDocument?.content.purpose ?? null,
          },
    milestone:
      assignedMilestone === null
        ? null
        : {
            key: assignedMilestone.key,
            title: assignedMilestone.title,
            status: assignedMilestone.status,
            roadmapOrder: assignedMilestone.roadmapOrder,
            streamRank: parentStream?.roadmapRank ?? null,
          },
    ...sections,
    evidenceSources: catalogs(
      evidenceCatalog(
        "epic",
        parentEpic?.key ?? "",
        parentEpic?.revision ?? 0,
        epicDocument,
        uses.filter((use) => use.source === "epic_application"),
      ),
      streamRevision === null
        ? null
        : evidenceCatalog(
            "stream",
            parentStream?.key ?? "",
            streamRevision,
            streamDocument,
            sections,
          ),
      evidenceCatalog("task", subject.key, subject.revision, taskDocument, taskDocument?.content),
    ),
    dependencies: groupDependencies(dependencies),
    relations,
    rules,
  };
}
