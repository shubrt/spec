import type { Aggregate, LoadedBoard } from "~/server/board";
import type { DependencyState } from "~/components/zpecs/box";
import { asNumber, asText, asTextArray, contentOf, executionOf, metaOf } from "./document";
import {
  IMPLEMENTS_FIELD_SECTIONS,
  fragmentAnchor,
  readFragments,
  readRuleApplications,
  readSources,
  type RuleApplicationModel,
  type SectionId,
  type SourceModel,
  type SpecFragmentModel,
} from "./fragments";
import {
  dependencyWaves,
  longestBlockerChain,
  possibleCollisions,
  type DependencyEdge,
  type PossibleCollision,
} from "./graph";
import {
  ENTITY_PRIORITY,
  EXECUTOR_KIND,
  keySequence,
  priorityRank,
  statusRank,
  type EntityPriority,
  type EpicStatus,
  type ExecutorKind,
  type MilestoneStatus,
  type RuleStatus,
  type StreamStatus,
  type StreamType,
  type TaskStatus,
  type TaskType,
} from "./vocabulary";

/**
 * The one projection every screen reads.
 *
 * Built once per loaded aggregate and shared, because almost every column on
 * almost every screen is derived rather than stored: an Epic keeps no counts, a
 * Stream keeps no task totals, and dependency blocking lives in a separate table
 * from status. Recomputing that per component would let two screens disagree
 * about the same number.
 *
 * ## The two signals that never merge
 *
 * `status` is what the entity stores. `dependency` is whether an unfinished
 * prerequisite is holding it. They are separate fields here for the same reason
 * they are separate columns on screen: a Stream can be In progress *and* blocked,
 * and a single column would have to pick one and hide the other.
 *
 * ## Executability is derived, and labelled that way
 *
 * `executable` applies the same rules the next-work service does — an active
 * Epic, a Stream that is ready or in progress and not blocked, a Task that is
 * ready or in progress and not blocked. It is computed here from stored status and
 * the dependency graph, and every surface that shows it says so. It is not the
 * service's answer replayed: there is no result cap and no exclusion tally,
 * because this is a projection over data the page already holds.
 */

/* ------------------------------------------------------------------- rows -- */

interface EntityCommon {
  readonly key: string;
  readonly title: string;
  readonly summary: string | null;
  readonly revision: number;
  readonly updatedAt: string;
  readonly createdAt: string;
  readonly priority: EntityPriority | null;
}

/** One resolved end of a `blocked_by` edge, with whether it still holds. */
export interface BlockerRef {
  readonly key: string;
  readonly title: string;
  readonly status: StreamStatus | TaskStatus;
  /**
   * A prerequisite is satisfied when it reaches its own terminal success state —
   * `completed` for a Stream, `done` for a Task. `cancelled` deliberately does
   * not satisfy it: abandoning a prerequisite does not deliver what depended on
   * it, so the edge keeps holding until someone removes or replaces it.
   */
  readonly satisfied: boolean;
  readonly reason: string | null;
}

/** A semantic relation. It records that two entities are connected and never blocks. */
export interface RelationRef {
  readonly key: string;
  readonly title: string;
  readonly relationship: string;
  readonly reason: string | null;
  readonly direction: "outgoing" | "incoming";
}

export interface EpicRow extends EntityCommon {
  readonly status: EpicStatus;
  readonly streamCount: number;
  readonly streamsCompleted: number;
  readonly taskCount: number;
  readonly tasksDone: number;
  readonly readyNow: number;
  readonly blockedStreams: number;
  readonly executableTasks: number;
  /** Fragments in the Streams beneath it, not in its own document. */
  readonly fragmentCount: number;
  readonly purpose: string;
  readonly businessProblem: string;
  /** The Epic's own scope, outcomes, metrics, questions and assumptions. */
  readonly fragments: readonly SpecFragmentModel[];
  readonly ruleApplications: readonly RuleApplicationModel[];
}

export interface StreamRow extends EntityCommon {
  readonly epicKey: string;
  readonly epicTitle: string;
  readonly streamType: StreamType;
  readonly status: StreamStatus;
  readonly milestoneKey: string | null;
  readonly milestoneTitle: string | null;
  /** Advisory ordering inside the Milestone. Never a dependency. */
  readonly roadmapRank: number | null;
  readonly taskCount: number;
  readonly tasksDone: number;
  readonly dependency: DependencyState;
  readonly blockedBy: readonly BlockerRef[];
  readonly blocks: readonly BlockerRef[];
  readonly relations: readonly RelationRef[];
  readonly purpose: string;
  readonly deliversAlone: string | null;
  readonly actor: { readonly primary: string; readonly secondary: readonly string[] } | null;
  readonly fragments: readonly SpecFragmentModel[];
  readonly sources: readonly SourceModel[];
  readonly ruleApplications: readonly RuleApplicationModel[];
  /** Derived: this Stream could be worked on now. */
  readonly executable: boolean;
}

/** One typed reference from a Task to a fragment of its parent Stream. */
export interface TaskTarget {
  readonly anchor: string;
  readonly owner: string;
  readonly id: string;
  /** Which `implements` field named it, and therefore which namespace it is in. */
  readonly field: string;
  /** The fragment itself, when the owner holds one with that id. */
  readonly fragment: SpecFragmentModel | null;
}

export interface TaskRow extends EntityCommon {
  readonly streamKey: string;
  readonly streamTitle: string;
  readonly epicKey: string;
  readonly taskType: TaskType;
  readonly status: TaskStatus;
  readonly dependency: DependencyState;
  readonly blockedBy: readonly BlockerRef[];
  readonly blocks: readonly BlockerRef[];
  /** Inherited: a blocked Stream holds every Task under it, whatever their own status. */
  readonly streamBlocked: boolean;
  readonly executor: ExecutorKind | null;
  readonly estimate: string | null;
  readonly assignee: string | null;
  readonly objective: string;
  readonly targets: readonly TaskTarget[];
  readonly ruleKeys: readonly string[];
  readonly scope: readonly string[];
  readonly verificationCount: number;
  readonly doneWhenCount: number;
  /** The Task's own open questions and assumptions. */
  readonly fragments: readonly SpecFragmentModel[];
  readonly executable: boolean;
}

export interface MilestoneRow extends EntityCommon {
  readonly status: MilestoneStatus;
  /** Server-managed advisory position. Equal values are valid and mean equal. */
  readonly roadmapOrder: number;
  readonly goal: string;
  readonly exitCriteria: readonly SpecFragmentModel[];
  readonly openQuestions: readonly SpecFragmentModel[];
  readonly streamKeys: readonly string[];
}

export interface RuleRow extends EntityCommon {
  readonly status: RuleStatus;
  readonly statement: string;
  readonly rationale: string | null;
  readonly impact: string | null;
  readonly consequence: string | null;
  readonly evidenceBasis: string | null;
  readonly evidenceSourceIds: readonly string[];
  /** Entities whose own document names this Rule. Nothing is rolled up from descendants. */
  readonly namedByEpics: readonly string[];
  readonly namedByStreams: readonly string[];
  readonly namedByTasks: readonly string[];
  readonly consumerCount: number;
}

export interface ProjectModel {
  readonly projectId: string;
  readonly projectName: string;
  readonly workspaceName: string;
  readonly createdAt: string;
  readonly updatedAt: string;

  readonly epics: readonly EpicRow[];
  readonly streams: readonly StreamRow[];
  readonly tasks: readonly TaskRow[];
  readonly milestones: readonly MilestoneRow[];
  readonly rules: readonly RuleRow[];

  readonly epicByKey: ReadonlyMap<string, EpicRow>;
  readonly streamByKey: ReadonlyMap<string, StreamRow>;
  readonly taskByKey: ReadonlyMap<string, TaskRow>;
  readonly milestoneByKey: ReadonlyMap<string, MilestoneRow>;
  readonly ruleByKey: ReadonlyMap<string, RuleRow>;

  /** Stream-level `blocked_by` edges — the only ones that carry an order. */
  readonly streamDependencies: readonly DependencyEdge[];
  readonly taskDependencies: readonly DependencyEdge[];
  /** Everything that is not `blocked_by`, between Streams. */
  readonly streamRelations: readonly RelationRef[];
  readonly relationEdges: readonly {
    readonly from: string;
    readonly to: string;
    readonly relationship: string;
    readonly reason: string | null;
  }[];

  /** Derived at read time. Not stored, and not a schedule. */
  readonly waves: readonly (readonly string[])[];
  readonly waveOfStream: ReadonlyMap<string, number>;
  readonly unresolvedWaveStreams: readonly string[];
  readonly longestChain: readonly string[];
  readonly collisions: readonly PossibleCollision[];

  /** Every addressable fragment in the project, with its owner. */
  readonly fragments: readonly SpecFragmentModel[];
  /** Tasks that name a given `owner#id` in their `implements` edge. */
  readonly implementedBy: ReadonlyMap<string, readonly string[]>;
  readonly totalRevisions: number;
  readonly linkCount: number;
}

/* ---------------------------------------------------------------- helpers -- */

const STREAM_SATISFIED: StreamStatus = "completed";
const TASK_SATISFIED: TaskStatus = "done";

function priorityOf(document: Record<string, unknown>): EntityPriority | null {
  const value = metaOf(document as never).priority;
  return ENTITY_PRIORITY.find((candidate) => candidate === value) ?? null;
}

function executorOf(document: Record<string, unknown>): ExecutorKind | null {
  const value = executionOf(document as never).executor_kind;
  return EXECUTOR_KIND.find((candidate) => candidate === value) ?? null;
}

function dependencyState(blockers: readonly BlockerRef[]): DependencyState {
  const open = blockers.filter((blocker) => !blocker.satisfied).length;
  if (open > 0) return { kind: "blocked", openCount: open };
  return blockers.length > 0 ? { kind: "met" } : { kind: "none" };
}

/** A key column sorts by its number, so `S-9` comes before `S-10`. */
function byKey<Row extends { readonly key: string }>(left: Row, right: Row): number {
  return keySequence(left.key) - keySequence(right.key);
}

/** Work in flight first, then what could start, then priority, then key. */
function byWorkOrder<
  Row extends { readonly key: string; readonly priority: EntityPriority | null },
>(statusOf: (row: Row) => number, executableOf: (row: Row) => boolean) {
  return (left: Row, right: Row): number =>
    Number(executableOf(right)) - Number(executableOf(left)) ||
    statusOf(left) - statusOf(right) ||
    priorityRank(left.priority) - priorityRank(right.priority) ||
    byKey(left, right);
}

/* ------------------------------------------------------------------- build -- */

export function buildProjectModel(board: LoadedBoard & { aggregate: Aggregate }): ProjectModel {
  const { aggregate, workspace } = board;

  const flatStreams = aggregate.epics.flatMap((epic) =>
    epic.streams.map((stream) => ({ epic, stream })),
  );
  const flatTasks = flatStreams.flatMap(({ epic, stream }) =>
    stream.tasks.map((task) => ({ epic, stream, task })),
  );

  /* -- links, split by what they claim -------------------------------------- */

  // `entity_link` stores only `blocked_by`, and stores it dependent-first: the
  // source waits for the target. Reading it in the other direction would silently
  // invert every arrow on the Roadmap.
  const blockedBy = aggregate.links.filter((link) => link.relationship === "blocked_by");
  const streamDependencies: readonly DependencyEdge[] = blockedBy
    .filter((link) => link.sourceType === "stream")
    .map((link) => ({
      dependent: link.sourceKey,
      prerequisite: link.targetKey,
      reason: link.reason,
    }));
  const taskDependencies: readonly DependencyEdge[] = blockedBy
    .filter((link) => link.sourceType === "task")
    .map((link) => ({
      dependent: link.sourceKey,
      prerequisite: link.targetKey,
      reason: link.reason,
    }));

  const relationEdges = aggregate.links
    .filter((link) => link.relationship !== "blocked_by")
    .map((link) => ({
      from: link.sourceKey,
      to: link.targetKey,
      relationship: link.relationship,
      reason: link.reason,
    }));

  /* -- status and title lookups, before any row is built -------------------- */

  const streamStatusByKey = new Map<string, StreamStatus>();
  const streamTitleByKey = new Map<string, string>();
  for (const { stream } of flatStreams) {
    streamStatusByKey.set(stream.key, stream.status);
    streamTitleByKey.set(stream.key, stream.title);
  }
  const taskStatusByKey = new Map<string, TaskStatus>();
  const taskTitleByKey = new Map<string, string>();
  for (const { task } of flatTasks) {
    taskStatusByKey.set(task.key, task.status);
    taskTitleByKey.set(task.key, task.title);
  }

  const streamBlockers = resolveBlockers(
    streamDependencies,
    streamStatusByKey,
    streamTitleByKey,
    STREAM_SATISFIED,
  );
  const taskBlockers = resolveBlockers(
    taskDependencies,
    taskStatusByKey,
    taskTitleByKey,
    TASK_SATISFIED,
  );

  /* -- milestone assignment ------------------------------------------------- */

  const milestoneOfStream = new Map<string, { key: string; title: string; rank: number | null }>();
  for (const milestone of aggregate.milestones) {
    for (const reference of milestone.streams) {
      milestoneOfStream.set(reference.key, {
        key: milestone.key,
        title: milestone.title,
        rank: reference.roadmapRank,
      });
    }
  }

  /* -- Streams --------------------------------------------------------------- */

  const activeEpicKeys = new Set(
    aggregate.epics.filter((epic) => epic.status === "active").map((epic) => epic.key),
  );

  const streams: readonly StreamRow[] = flatStreams
    .map(({ epic, stream }) => {
      const content = contentOf(stream.document);
      const blockers = streamBlockers.blockedBy.get(stream.key) ?? [];
      const dependency = dependencyState(blockers);
      const milestone = milestoneOfStream.get(stream.key) ?? null;
      const actorRecord = content.actor;
      const primary = asText(
        typeof actorRecord === "object" && actorRecord !== null && !Array.isArray(actorRecord)
          ? actorRecord.primary
          : undefined,
      );
      const verticalSlice = content.vertical_slice;

      return {
        key: stream.key,
        title: stream.title,
        summary: stream.summary,
        revision: stream.revision,
        updatedAt: stream.updatedAt,
        createdAt: stream.createdAt,
        priority: priorityOf(stream.document),
        epicKey: epic.key,
        epicTitle: epic.title,
        streamType: stream.streamType,
        status: stream.status,
        milestoneKey: milestone?.key ?? null,
        milestoneTitle: milestone?.title ?? null,
        roadmapRank: milestone?.rank ?? null,
        taskCount: stream.tasks.length,
        tasksDone: stream.tasks.filter((task) => task.status === TASK_SATISFIED).length,
        dependency,
        blockedBy: blockers,
        blocks: streamBlockers.blocks.get(stream.key) ?? [],
        relations: relationsFor(relationEdges, stream.key, streamTitleByKey),
        purpose: asText(content.purpose),
        deliversAlone:
          typeof verticalSlice === "object" &&
          verticalSlice !== null &&
          !Array.isArray(verticalSlice)
            ? asText(verticalSlice.delivers_alone) || null
            : null,
        actor:
          primary.length > 0
            ? {
                primary,
                secondary: asTextArray(
                  typeof actorRecord === "object" &&
                    actorRecord !== null &&
                    !Array.isArray(actorRecord)
                    ? actorRecord.secondary
                    : undefined,
                ),
              }
            : null,
        fragments: readFragments(stream.key, stream.document),
        sources: readSources(stream.document),
        ruleApplications: readRuleApplications(stream.document),
        // Derived: an active Epic, a workable status, nothing holding it.
        executable:
          activeEpicKeys.has(epic.key) &&
          (stream.status === "ready" || stream.status === "in_progress") &&
          dependency.kind !== "blocked",
      } satisfies StreamRow;
    })
    .sort(
      byWorkOrder<StreamRow>(
        (row) => statusRank(row.status),
        (row) => row.executable,
      ),
    );

  const streamByKey = new Map(streams.map((row) => [row.key, row]));

  /* -- fragments, before Tasks, because a Task resolves its targets --------- */

  const fragmentByAnchor = new Map<string, SpecFragmentModel>();
  for (const stream of streams) {
    for (const fragment of stream.fragments) {
      fragmentByAnchor.set(fragmentAnchor(fragment.owner, fragment.id), fragment);
    }
  }

  /* -- Tasks ---------------------------------------------------------------- */

  const tasks: readonly TaskRow[] = flatTasks
    .map(({ epic, stream, task }) => {
      const content = contentOf(task.document);
      const execution = executionOf(task.document);
      const blockers = taskBlockers.blockedBy.get(task.key) ?? [];
      const ownDependency = dependencyState(blockers);
      const parent = streamByKey.get(stream.key);
      const streamBlocked = parent?.dependency.kind === "blocked";
      const targets = readTargets(content.implements, stream.key, fragmentByAnchor);
      const estimate = execution.estimate;
      const assignee = execution.assignee;

      return {
        key: task.key,
        title: task.title,
        summary: task.summary,
        revision: task.revision,
        updatedAt: task.updatedAt,
        createdAt: task.createdAt,
        priority: priorityOf(task.document),
        streamKey: stream.key,
        streamTitle: stream.title,
        epicKey: epic.key,
        taskType: task.taskType,
        status: task.status,
        dependency: ownDependency,
        blockedBy: blockers,
        blocks: taskBlockers.blocks.get(task.key) ?? [],
        streamBlocked,
        executor: executorOf(task.document),
        estimate: formatEstimate(estimate),
        assignee:
          typeof assignee === "object" && assignee !== null && !Array.isArray(assignee)
            ? asText(assignee.id) || null
            : null,
        objective: asText(content.objective),
        targets,
        ruleKeys: asTextArray(content.constrained_by_rule_keys),
        scope: technicalScopeOf(content.technical_scope),
        verificationCount: countOf(content.verification),
        doneWhenCount: countOf(content.done_when),
        fragments: readFragments(task.key, task.document),
        // A blocked parent hides every Task under it from executable work,
        // whatever the Task's own status says.
        executable:
          activeEpicKeys.has(epic.key) &&
          !streamBlocked &&
          (stream.status === "ready" || stream.status === "in_progress") &&
          (task.status === "ready" || task.status === "in_progress") &&
          ownDependency.kind !== "blocked",
      } satisfies TaskRow;
    })
    .sort(
      byWorkOrder<TaskRow>(
        (row) => statusRank(row.status),
        (row) => row.executable,
      ),
    );

  const taskByKey = new Map(tasks.map((row) => [row.key, row]));

  /* -- what implements what ------------------------------------------------- */

  const implementedBy = new Map<string, string[]>();
  for (const task of tasks) {
    for (const target of task.targets) {
      const bucket = implementedBy.get(target.anchor);
      if (bucket) bucket.push(task.key);
      else implementedBy.set(target.anchor, [task.key]);
    }
  }

  /* -- Epics ---------------------------------------------------------------- */

  const epics: readonly EpicRow[] = aggregate.epics
    .map((epic) => {
      const own = streams.filter((row) => row.epicKey === epic.key);
      const ownTasks = tasks.filter((row) => row.epicKey === epic.key);
      const fragmentCount = own.reduce((sum, row) => sum + row.fragments.length, 0);
      const content = contentOf(epic.document);
      return {
        key: epic.key,
        title: epic.title,
        summary: epic.summary,
        revision: epic.revision,
        updatedAt: epic.updatedAt,
        createdAt: epic.createdAt,
        priority: priorityOf(epic.document),
        status: epic.status,
        streamCount: own.length,
        streamsCompleted: own.filter((row) => row.status === STREAM_SATISFIED).length,
        taskCount: ownTasks.length,
        tasksDone: ownTasks.filter((row) => row.status === TASK_SATISFIED).length,
        readyNow: own.filter(
          (row) =>
            (row.status === "ready" || row.status === "in_progress") &&
            row.dependency.kind !== "blocked",
        ).length,
        blockedStreams: own.filter((row) => row.dependency.kind === "blocked").length,
        executableTasks: ownTasks.filter((row) => row.executable).length,
        fragmentCount,
        purpose: asText(content.purpose),
        businessProblem: asText(content.business_problem),
        fragments: readFragments(epic.key, epic.document),
        ruleApplications: readRuleApplications(epic.document),
      } satisfies EpicRow;
    })
    .sort(
      (left, right) => statusRank(left.status) - statusRank(right.status) || byKey(left, right),
    );

  /* -- Milestones ----------------------------------------------------------- */

  const milestones: readonly MilestoneRow[] = aggregate.milestones
    .map((milestone) => {
      const fragments = readFragments(milestone.key, milestone.document);
      return {
        key: milestone.key,
        title: milestone.title,
        summary: milestone.summary,
        revision: milestone.revision,
        updatedAt: milestone.updatedAt,
        createdAt: milestone.createdAt,
        priority: priorityOf(milestone.document),
        status: milestone.status,
        roadmapOrder: milestone.roadmapOrder,
        goal: asText(contentOf(milestone.document).goal),
        exitCriteria: fragments.filter((fragment) => fragment.section === "exit_criteria"),
        openQuestions: fragments.filter((fragment) => fragment.section === "open_questions"),
        streamKeys: milestone.streams.map((reference) => reference.key),
      } satisfies MilestoneRow;
    })
    // Advisory order, then key. Equal `roadmapOrder` values are valid and stay
    // equal: two Milestones planned at the same position do not gate each other.
    .sort((left, right) => left.roadmapOrder - right.roadmapOrder || byKey(left, right));

  /* -- Rules and their direct consumers ------------------------------------- */

  // Direct and only direct. An inherited count reads as reach the Rule does not
  // have: a Rule its Epic applies does not thereby govern every Stream beneath it,
  // because the data does not say so.
  const rules: readonly RuleRow[] = aggregate.rules
    .map((rule) => {
      const content = contentOf(rule.document);
      const evidence = content.evidence;
      const evidenceRecord =
        typeof evidence === "object" && evidence !== null && !Array.isArray(evidence)
          ? evidence
          : {};
      const namedByEpics = epics
        .filter((epic) => epic.ruleApplications.some((use) => use.ruleKey === rule.key))
        .map((epic) => epic.key);
      const namedByStreams = streams
        .filter((stream) => stream.ruleApplications.some((use) => use.ruleKey === rule.key))
        .map((stream) => stream.key);
      const namedByTasks = tasks
        .filter((task) => task.ruleKeys.includes(rule.key))
        .map((task) => task.key);

      return {
        key: rule.key,
        title: rule.title,
        summary: rule.summary,
        revision: rule.revision,
        updatedAt: rule.updatedAt,
        createdAt: rule.createdAt,
        priority: priorityOf(rule.document),
        status: rule.status,
        statement: asText(content.statement),
        rationale: asText(content.rationale) || null,
        impact: asText(content.impact) || null,
        consequence: asText(content.consequence) || null,
        evidenceBasis: asText(evidenceRecord.basis) || null,
        evidenceSourceIds: asTextArray(evidenceRecord.source_ids),
        namedByEpics,
        namedByStreams,
        namedByTasks,
        consumerCount: namedByEpics.length + namedByStreams.length + namedByTasks.length,
      } satisfies RuleRow;
    })
    .sort(byKey);

  /* -- derived graph -------------------------------------------------------- */

  const { waves, unresolved } = dependencyWaves(streamDependencies);
  const waveOfStream = new Map<string, number>();
  waves.forEach((wave, index) => {
    for (const key of wave) waveOfStream.set(key, index);
  });

  const openTasks = tasks.filter((task) => task.status !== "done" && task.status !== "cancelled");
  const collisions = possibleCollisions(
    openTasks.map((task) => ({ key: task.key, streamKey: task.streamKey, scope: task.scope })),
    waveOfStream,
  );

  return {
    projectId: aggregate.project.id,
    projectName: aggregate.project.name,
    workspaceName: workspace.name,
    createdAt: aggregate.project.createdAt,
    updatedAt: aggregate.project.updatedAt,

    epics,
    streams,
    tasks,
    milestones,
    rules,

    epicByKey: new Map(epics.map((row) => [row.key, row])),
    streamByKey,
    taskByKey,
    milestoneByKey: new Map(milestones.map((row) => [row.key, row])),
    ruleByKey: new Map(rules.map((row) => [row.key, row])),

    streamDependencies,
    taskDependencies,
    streamRelations: streams.flatMap((stream) => stream.relations),
    relationEdges,

    waves,
    waveOfStream,
    unresolvedWaveStreams: unresolved,
    longestChain: longestBlockerChain(streamDependencies),
    collisions,

    // Every addressable fragment in the Project, not just the Streams'. An Epic
    // carries scope, outcomes and success metrics; a Milestone carries exit
    // criteria. Leaving them out made "every typed fragment" a claim the index
    // did not keep.
    fragments: [
      ...epics.flatMap((row) => row.fragments),
      ...fragmentByAnchor.values(),
      ...tasks.flatMap((row) => row.fragments),
      ...milestones.flatMap((row) => [...row.exitCriteria, ...row.openQuestions]),
    ],
    implementedBy,
    // Every entity is at revision N, which means N revision rows exist for it.
    // Summing avoids a second request for a number the payload already implies.
    totalRevisions:
      epics.reduce((sum, row) => sum + row.revision, 0) +
      streams.reduce((sum, row) => sum + row.revision, 0) +
      tasks.reduce((sum, row) => sum + row.revision, 0) +
      milestones.reduce((sum, row) => sum + row.revision, 0) +
      rules.reduce((sum, row) => sum + row.revision, 0),
    linkCount: aggregate.links.length,
  };
}

/* ------------------------------------------------------- resolution helpers -- */

/**
 * Both directions of the dependency graph, from the one stored direction.
 *
 * `entity_link` holds `blocked_by` source-is-blocked, so "what holds me" is the
 * rows where I am the source and "what I would release" is the rows where I am the
 * target. Deriving both from one table is what keeps them from disagreeing.
 */
function resolveBlockers<Status extends string>(
  edges: readonly DependencyEdge[],
  statusByKey: ReadonlyMap<string, Status>,
  titleByKey: ReadonlyMap<string, string>,
  satisfiedStatus: Status,
): {
  readonly blockedBy: ReadonlyMap<string, readonly BlockerRef[]>;
  readonly blocks: ReadonlyMap<string, readonly BlockerRef[]>;
} {
  const blockedBy = new Map<string, BlockerRef[]>();
  const blocks = new Map<string, BlockerRef[]>();

  for (const edge of edges) {
    const prerequisiteStatus = statusByKey.get(edge.prerequisite);
    const dependentStatus = statusByKey.get(edge.dependent);
    if (prerequisiteStatus === undefined || dependentStatus === undefined) continue;

    const asBlocker: BlockerRef = {
      key: edge.prerequisite,
      title: titleByKey.get(edge.prerequisite) ?? "",
      status: prerequisiteStatus as BlockerRef["status"],
      satisfied: prerequisiteStatus === satisfiedStatus,
      reason: edge.reason,
    };
    const asReleased: BlockerRef = {
      key: edge.dependent,
      title: titleByKey.get(edge.dependent) ?? "",
      status: dependentStatus as BlockerRef["status"],
      satisfied: dependentStatus === satisfiedStatus,
      reason: edge.reason,
    };

    const held = blockedBy.get(edge.dependent);
    if (held) held.push(asBlocker);
    else blockedBy.set(edge.dependent, [asBlocker]);

    const released = blocks.get(edge.prerequisite);
    if (released) released.push(asReleased);
    else blocks.set(edge.prerequisite, [asReleased]);
  }

  return { blockedBy, blocks };
}

/** Semantic relations touching one entity, in either direction, direction kept. */
function relationsFor(
  edges: readonly {
    readonly from: string;
    readonly to: string;
    readonly relationship: string;
    readonly reason: string | null;
  }[],
  key: string,
  titleByKey: ReadonlyMap<string, string>,
): readonly RelationRef[] {
  return edges.flatMap((edge): readonly RelationRef[] => {
    if (edge.from === key) {
      return [
        {
          key: edge.to,
          title: titleByKey.get(edge.to) ?? "",
          relationship: edge.relationship,
          reason: edge.reason,
          direction: "outgoing",
        },
      ];
    }
    if (edge.to === key) {
      return [
        {
          key: edge.from,
          title: titleByKey.get(edge.from) ?? "",
          relationship: edge.relationship,
          reason: edge.reason,
          direction: "incoming",
        },
      ];
    }
    return [];
  });
}

/**
 * A Task's typed references into its parent Stream.
 *
 * Every id is paired with its owner before it leaves this function. A Task's
 * targets live in another entity, so `CHG-1` on its own is not a reference — it is
 * a reference *inside the Stream*, and the anchor is the only globally unique form.
 */
function readTargets(
  implementsValue: unknown,
  streamKey: string,
  fragmentByAnchor: ReadonlyMap<string, SpecFragmentModel>,
): readonly TaskTarget[] {
  const record =
    typeof implementsValue === "object" &&
    implementsValue !== null &&
    !Array.isArray(implementsValue)
      ? (implementsValue as Record<string, unknown>)
      : {};

  return Object.keys(IMPLEMENTS_FIELD_SECTIONS).flatMap((field) =>
    asTextArray(record[field]).map((id) => {
      const anchor = fragmentAnchor(streamKey, id);
      return {
        anchor,
        owner: streamKey,
        id,
        field,
        fragment: fragmentByAnchor.get(anchor) ?? null,
      };
    }),
  );
}

/** Every name from `technical_scope`, flattened across its five lists. */
function technicalScopeOf(value: unknown): readonly string[] {
  const record =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return ["repositories", "services", "components", "interfaces", "data_models"].flatMap((field) =>
    asTextArray(record[field]),
  );
}

function countOf(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

/**
 * A coarse effort estimate — the one quantity beside a revision timestamp that
 * this product records about time. It is never a scheduled duration and no screen
 * places it on an axis.
 */
function formatEstimate(value: unknown): string | null {
  const record =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const amount = asNumber(record.value);
  const unit = asText(record.unit);
  if (amount === null || unit.length === 0) return null;
  const confidence = asText(record.confidence);
  const base = `${String(amount)} ${unit}`;
  return confidence.length > 0 ? `${base} · ${confidence} confidence` : base;
}

/** The sections a Stream of this type can actually hold, in reading order. */
export function sectionsPresent(fragments: readonly SpecFragmentModel[]): readonly SectionId[] {
  const seen = new Set<SectionId>();
  for (const fragment of fragments) seen.add(fragment.section);
  return [...seen];
}
