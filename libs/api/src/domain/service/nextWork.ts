import type { WorkspaceScope } from "../auth/workspaceScope";
import {
  EXECUTOR_KIND,
  type EpicStatus,
  type ExecutorKind,
  type StreamStatus,
  type StreamType,
  type TaskStatus,
  type TaskType,
} from "../enums";
import { parseHierarchyKey } from "../keys";
import { dependencyRepository } from "../repository/dependency";
import type { DbExecutor } from "../repository/entity";
import { epicRepository } from "../repository/epic";
import { milestoneRepository } from "../repository/milestone";
import { type Stream, streamRepository } from "../repository/stream";
import { type Task, taskRepository } from "../repository/task";
import { workspaceRepository } from "../repository/workspace";

/**
 * `get_next_work` selects executable Tasks and Streams that need decomposition.
 * It walks the whole parent chain and assigns every hidden branch one explicit
 * first cause, so "no work" never conflates an inactive parent, a hard blocker,
 * a workflow status and an executor mismatch.
 *
 * Hard dependencies are level-preserving: Task → Task is satisfied only by
 * `done`; Stream → Stream only by `completed`. `cancelled` satisfies neither.
 * A Stream blocker is inherited by every Task below that Stream.
 */

/** `meta.priority`, most urgent first. Absence sorts below `low`. */
export const PRIORITY_RANK = ["critical", "high", "medium", "low"] as const;
export type WorkPriority = (typeof PRIORITY_RANK)[number];

const UNPRIORITISED_RANK = PRIORITY_RANK.length;
const ACTIVE_EPIC_STATUS: EpicStatus = "active";

export const WORKABLE_TASK_STATUS = [
  "ready",
  "in_progress",
] as const satisfies readonly TaskStatus[];

export const WORKABLE_STREAM_STATUS = [
  "ready",
  "in_progress",
] as const satisfies readonly StreamStatus[];

/** `either` is an item value, never a caller persona. */
export const NEXT_WORK_EXECUTOR_FILTER = ["human", "agent"] as const;
export type NextWorkExecutorFilter = (typeof NEXT_WORK_EXECUTOR_FILTER)[number];

/** What `get_next_work` is pointed at. Rules and Tasks are refused by the tool. */
export type NextWorkSubject = {
  readonly entity: "project" | "milestone" | "epic" | "stream";
  readonly id: string;
  readonly key: string;
};

/** Advisory roadmap placement. `null` means Backlog/unranked, never zero. */
export type NextWorkRoadmapPosition = {
  readonly milestoneOrder: number | null;
  readonly streamOrder: number | null;
};

type NextWorkItemBase = {
  readonly key: string;
  readonly title: string;
  readonly status: WorkableStatus;
  readonly priority: WorkPriority | null;
  readonly roadmap: NextWorkRoadmapPosition | null;
};

export type NextWorkTaskExecution = NextWorkItemBase & {
  readonly kind: "task_execution";
  readonly taskType: TaskType;
  readonly executorKind: ExecutorKind | null;
  readonly streamKey: string;
  readonly streamTitle: string;
  readonly streamStatus: "ready" | "in_progress";
};

export type StreamPlanningReason = "no_tasks" | "draft_tasks_only";

export type NextWorkStreamPlanning = NextWorkItemBase & {
  readonly kind: "stream_planning";
  readonly streamType: StreamType;
  readonly reason: StreamPlanningReason;
};

export type NextWorkItem = NextWorkTaskExecution | NextWorkStreamPlanning;

type InactiveStreamStatus = Exclude<StreamStatus, "ready" | "in_progress">;
type InactiveTaskStatus = Exclude<TaskStatus, "ready" | "in_progress">;
type WorkableStatus = "ready" | "in_progress";
type WorkableStream = Omit<Stream, "status"> & { readonly status: WorkableStatus };
type WorkableTask = Omit<Task, "status"> & { readonly status: WorkableStatus };

/** Mutually ordered causes: parent state → dependency → item state → executor. */
export type NextWorkCauses = {
  readonly subjectUnavailable: number;
  readonly parentEpicNotActive: number;
  readonly streamStatus: Readonly<Record<InactiveStreamStatus, number>>;
  readonly streamDependencyBlocked: number;
  readonly taskStatus: Readonly<Record<InactiveTaskStatus, number>>;
  readonly taskDependencyBlocked: number;
  readonly taskExecutorUnknown: number;
  readonly taskExecutorMismatch: number;
  readonly planningExecutorUnknown: number;
};

export type NextWorkResult = {
  readonly items: readonly NextWorkItem[];
  /** Available work items before applying the response limit. */
  readonly availableCount: number;
  readonly taskExecutionCount: number;
  readonly streamPlanningCount: number;
  readonly truncated: boolean;
  readonly causes: NextWorkCauses;
  /** Streams in the requested scope, including inactive ones. */
  readonly streamCount: number;
};

export const DEFAULT_NEXT_WORK_LIMIT = 5;
export const MAX_NEXT_WORK_LIMIT = 20;

type CauseAccumulator = {
  -readonly [Key in keyof NextWorkCauses]: NextWorkCauses[Key] extends Readonly<
    Record<infer Status extends string, number>
  >
    ? Record<Status, number>
    : number;
};

type SubjectScope =
  | { readonly ok: false }
  | {
      readonly ok: true;
      readonly streams: readonly {
        readonly stream: Stream;
        readonly epicStatus: EpicStatus;
      }[];
    };

async function listNextWork(
  scope: WorkspaceScope,
  subject: NextWorkSubject,
  options: {
    readonly limit?: number;
    readonly executor?: NextWorkExecutorFilter;
  } = {},
  executor?: DbExecutor,
): Promise<NextWorkResult> {
  const causes = emptyCauses();
  const subjectScope = await resolveSubjectScope(scope, subject, executor);
  if (!subjectScope.ok) {
    causes.subjectUnavailable = 1;
    return result([], 0, causes, options.limit);
  }

  const streamCount = subjectScope.streams.length;

  const statusEligible: WorkableStream[] = [];
  for (const { stream: candidate, epicStatus } of subjectScope.streams) {
    if (epicStatus !== ACTIVE_EPIC_STATUS) {
      causes.parentEpicNotActive += 1;
      continue;
    }
    const workable = asWorkableStream(candidate);
    if (workable !== null) {
      statusEligible.push(workable);
    } else {
      countInactiveStreamStatus(causes.streamStatus, candidate.status);
    }
  }
  if (statusEligible.length === 0) {
    return result([], streamCount, causes, options.limit);
  }

  const streamIds = statusEligible.map((candidate) => candidate.id);
  const roadmapByStream = new Map(
    (await streamRepository.listRoadmapPositions(scope, streamIds, executor)).map(
      ({ streamId, ...position }) => [streamId, position],
    ),
  );
  const blockedStreams = await dependencyRepository.blockedIds(
    scope,
    { entity: "stream", ids: streamIds },
    executor,
  );
  const tasks = await taskRepository.listByStreams(scope, { streamIds }, executor);

  const availableStreams = statusEligible.filter((candidate) => {
    if (!blockedStreams.has(candidate.id)) {
      return true;
    }
    causes.streamDependencyBlocked += 1;
    return false;
  });
  if (availableStreams.length === 0) {
    return result([], streamCount, causes, options.limit);
  }

  const availableStreamIds = new Set(availableStreams.map((candidate) => candidate.id));
  const tasksByStream = new Map<string, Task[]>(
    availableStreams.map((candidate) => [candidate.id, []]),
  );
  for (const candidate of tasks) {
    if (availableStreamIds.has(candidate.streamId)) {
      tasksByStream.get(candidate.streamId)?.push(candidate);
    }
  }

  const planning: NextWorkStreamPlanning[] = [];
  const taskCandidates: {
    readonly task: WorkableTask;
    readonly stream: WorkableStream;
    readonly roadmap: NextWorkRoadmapPosition | null;
  }[] = [];
  for (const parent of availableStreams) {
    const children = tasksByStream.get(parent.id) ?? [];
    const roadmap = roadmapByStream.get(parent.id) ?? null;
    const planningReason = streamPlanningReason(children);
    if (planningReason !== null) {
      if (options.executor === undefined) {
        planning.push(toStreamPlanning(parent, planningReason, roadmap));
      } else {
        // A Stream has no executor_kind. Treating planning as `either` would be a
        // guess, so a persona filter excludes it and reports the unknown explicitly.
        causes.planningExecutorUnknown += 1;
      }
    }

    for (const child of children) {
      const workable = asWorkableTask(child);
      if (workable !== null) {
        taskCandidates.push({ task: workable, stream: parent, roadmap });
      } else {
        countInactiveTaskStatus(causes.taskStatus, child.status);
      }
    }
  }

  const blockedTasks = await dependencyRepository.blockedIds(
    scope,
    { entity: "task", ids: taskCandidates.map(({ task }) => task.id) },
    executor,
  );
  const executions: NextWorkTaskExecution[] = [];
  for (const candidate of taskCandidates) {
    if (blockedTasks.has(candidate.task.id)) {
      causes.taskDependencyBlocked += 1;
      continue;
    }
    const executorKind = readExecutorKind(candidate.task.document);
    if (options.executor !== undefined) {
      if (executorKind === null) {
        causes.taskExecutorUnknown += 1;
        continue;
      }
      if (!matchesExecutor(executorKind, options.executor)) {
        causes.taskExecutorMismatch += 1;
        continue;
      }
    }
    executions.push(
      toTaskExecution(candidate.task, candidate.stream, candidate.roadmap, executorKind),
    );
  }

  return result([...executions, ...planning], streamCount, causes, options.limit);
}

async function resolveSubjectScope(
  scope: WorkspaceScope,
  subject: NextWorkSubject,
  executor?: DbExecutor,
): Promise<SubjectScope> {
  if (subject.entity === "project") {
    const project = await workspaceRepository.findProject(scope, subject.id);
    if (project === null) return { ok: false };
    const [epics, streams] = await Promise.all([
      epicRepository.listByProject(scope, project.id, executor),
      streamRepository.listByProject(scope, project.id, executor),
    ]);
    const statusByEpic = new Map(epics.map((epic) => [epic.id, epic.status]));
    return {
      ok: true,
      streams: streams.flatMap((stream) => {
        const epicStatus = statusByEpic.get(stream.epicId);
        return epicStatus === undefined ? [] : [{ stream, epicStatus }];
      }),
    };
  }

  if (subject.entity === "milestone") {
    const milestone = await milestoneRepository.findById(scope, subject.id, executor);
    if (milestone === null) return { ok: false };
    const [epics, streams] = await Promise.all([
      epicRepository.listByProject(scope, milestone.projectId, executor),
      streamRepository.listByMilestone(scope, milestone.id, executor),
    ]);
    const statusByEpic = new Map(epics.map((epic) => [epic.id, epic.status]));
    return {
      ok: true,
      streams: streams.flatMap((stream) => {
        const epicStatus = statusByEpic.get(stream.epicId);
        return epicStatus === undefined ? [] : [{ stream, epicStatus }];
      }),
    };
  }

  if (subject.entity === "epic") {
    const parent = await epicRepository.findById(scope, subject.id, executor);
    if (parent === null) {
      return { ok: false };
    }
    const streams = await streamRepository.listByEpic(scope, parent.id, executor);
    return {
      ok: true,
      streams: streams.map((stream) => ({ stream, epicStatus: parent.status })),
    };
  }

  const stream = await streamRepository.findById(scope, subject.id, executor);
  if (stream === null) {
    return { ok: false };
  }
  const parent = await epicRepository.findById(scope, stream.epicId, executor);
  return parent === null
    ? { ok: false }
    : { ok: true, streams: [{ stream, epicStatus: parent.status }] };
}

function result(
  unordered: readonly NextWorkItem[],
  streamCount: number,
  causes: NextWorkCauses,
  limit: number | undefined,
): NextWorkResult {
  const ordered = [...unordered].sort(compareWork);
  const availableCount = ordered.length;
  const items = ordered.slice(0, clampLimit(limit));
  return {
    items,
    availableCount,
    taskExecutionCount: ordered.filter((item) => item.kind === "task_execution").length,
    streamPlanningCount: ordered.filter((item) => item.kind === "stream_planning").length,
    truncated: items.length < availableCount,
    causes,
    streamCount,
  };
}

const emptyCauses = (): CauseAccumulator => ({
  subjectUnavailable: 0,
  parentEpicNotActive: 0,
  streamStatus: { draft: 0, planned: 0, blocked: 0, completed: 0, cancelled: 0 },
  streamDependencyBlocked: 0,
  taskStatus: { draft: 0, blocked: 0, in_review: 0, done: 0, cancelled: 0 },
  taskDependencyBlocked: 0,
  taskExecutorUnknown: 0,
  taskExecutorMismatch: 0,
  planningExecutorUnknown: 0,
});

const isWorkableStreamStatus = (
  status: StreamStatus,
): status is (typeof WORKABLE_STREAM_STATUS)[number] =>
  status === "ready" || status === "in_progress";

const isWorkableTaskStatus = (
  status: TaskStatus,
): status is (typeof WORKABLE_TASK_STATUS)[number] =>
  status === "ready" || status === "in_progress";

const asWorkableStream = (stream: Stream): WorkableStream | null =>
  isWorkableStreamStatus(stream.status) ? { ...stream, status: stream.status } : null;

const asWorkableTask = (task: Task): WorkableTask | null =>
  isWorkableTaskStatus(task.status) ? { ...task, status: task.status } : null;

const countInactiveStreamStatus = (
  counts: Record<InactiveStreamStatus, number>,
  status: StreamStatus,
): void => {
  if (status !== "ready" && status !== "in_progress") {
    counts[status] += 1;
  }
};

const countInactiveTaskStatus = (
  counts: Record<InactiveTaskStatus, number>,
  status: TaskStatus,
): void => {
  if (status !== "ready" && status !== "in_progress") {
    counts[status] += 1;
  }
};

const streamPlanningReason = (tasks: readonly Task[]): StreamPlanningReason | null => {
  if (tasks.length === 0) {
    return "no_tasks";
  }
  return tasks.every((candidate) => candidate.status === "draft") ? "draft_tasks_only" : null;
};

const toTaskExecution = (
  task: WorkableTask,
  stream: WorkableStream,
  roadmap: NextWorkRoadmapPosition | null,
  executorKind: ExecutorKind | null,
): NextWorkTaskExecution => ({
  kind: "task_execution",
  key: task.key,
  title: task.title,
  taskType: task.taskType,
  status: task.status,
  priority: readPriority(task.document),
  executorKind,
  streamKey: stream.key,
  streamTitle: stream.title,
  streamStatus: stream.status,
  roadmap,
});

const toStreamPlanning = (
  stream: WorkableStream,
  reason: StreamPlanningReason,
  roadmap: NextWorkRoadmapPosition | null,
): NextWorkStreamPlanning => ({
  kind: "stream_planning",
  key: stream.key,
  title: stream.title,
  streamType: stream.streamType,
  status: stream.status,
  priority: readPriority(stream.document),
  reason,
  roadmap,
});

const recordOf = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const readExecutorKind = (document: Record<string, unknown>): ExecutorKind | null => {
  const value = recordOf(document.execution).executor_kind;
  return EXECUTOR_KIND.find((candidate) => candidate === value) ?? null;
};

const matchesExecutor = (kind: ExecutorKind, filter: NextWorkExecutorFilter): boolean =>
  kind === "either" || kind === filter;

const readPriority = (document: Record<string, unknown>): WorkPriority | null => {
  const value = recordOf(document.meta).priority;
  return PRIORITY_RANK.find((candidate) => candidate === value) ?? null;
};

/**
 * Started work first, then the optional Roadmap, then priority and numeric key.
 * Equal Roadmap ranks remain equal so the next criteria decide their display
 * order without turning a parallel wave into a dependency.
 */
function compareWork(left: NextWorkItem, right: NextWorkItem): number {
  const byProgress = progressRank(left.status) - progressRank(right.status);
  if (byProgress !== 0) {
    return byProgress;
  }
  const byMilestone =
    roadmapRank(left.roadmap?.milestoneOrder) - roadmapRank(right.roadmap?.milestoneOrder);
  if (byMilestone !== 0) {
    return byMilestone;
  }
  const byStream = roadmapRank(left.roadmap?.streamOrder) - roadmapRank(right.roadmap?.streamOrder);
  if (byStream !== 0) {
    return byStream;
  }
  const byPriority = priorityRank(left.priority) - priorityRank(right.priority);
  if (byPriority !== 0) {
    return byPriority;
  }
  const bySequence = sequenceOf(left.key) - sequenceOf(right.key);
  return bySequence === 0 ? left.key.localeCompare(right.key) : bySequence;
}

const progressRank = (status: WorkableStatus): number => (status === "in_progress" ? 0 : 1);

const roadmapRank = (rank: number | null | undefined): number =>
  rank === undefined || rank === null ? Number.MAX_SAFE_INTEGER : rank;

const priorityRank = (priority: WorkPriority | null): number =>
  priority === null ? UNPRIORITISED_RANK : PRIORITY_RANK.indexOf(priority);

/** A non-hierarchy key sorts last; every stored work key here is readable. */
const sequenceOf = (key: string): number =>
  parseHierarchyKey(key)?.sequence ?? Number.MAX_SAFE_INTEGER;

const clampLimit = (limit: number | undefined): number => {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DEFAULT_NEXT_WORK_LIMIT;
  }
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_NEXT_WORK_LIMIT);
};

export const nextWorkService = { listNextWork };
