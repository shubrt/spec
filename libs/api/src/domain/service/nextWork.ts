import type { WorkspaceScope } from "../auth/workspaceScope";
import type { TaskStatus, TaskType } from "../enums";
import { parseKey } from "../keys";
import { dependencyRepository } from "../repository/dependency";
import type { DbExecutor } from "../repository/entity";
import { streamRepository } from "../repository/stream";
import { type Task, taskRepository } from "../repository/task";

/**
 * `get_next_work` — the open, unblocked tasks of a stream or an epic, in priority
 * order (plan task B17).
 *
 * This is the only read in the system that answers a question rather than
 * returning a thing, so the three decisions in it are stated here rather than left
 * to be inferred from the query.
 *
 * ## Which statuses are workable
 *
 * `ready` and `in_progress`, and nothing else. A `draft` task has not passed the
 * §11 definition-of-done gate, so handing it to an agent is handing it something
 * to invent. `blocked` says a human already knows it cannot proceed. `in_review`
 * and `done` are finished as far as *doing* goes, and `cancelled` is abandoned.
 * `in_progress` is included because the honest answer to "what should I work on
 * next" includes work already started and not finished — with no lease and no
 * assignee gating in the MVP, that is a report, not a claim.
 *
 * ## What "unblocked" means
 *
 * No `blocked_by` edge to a task that is not `done`. Only task blockers count: a
 * `blocked_by` edge to a stream or an epic is representable, but neither has a
 * `done`, and inventing a mapping from "stream is completed" onto "the blocker is
 * satisfied" would be exactly the invention §14 forbids. A task blocked by a
 * stream therefore still appears here, and its dependency shows up in
 * `get_context`'s bundle where an agent can read it. Recorded as a known limit.
 *
 * ## Why the ordering happens here and not in SQL
 *
 * `priority` lives in `document.meta.priority`, not in a column. Ordering by it in
 * SQL means a `CASE` over a jsonb extraction, which no index can serve, so the
 * database would sort the same rows this function sorts — with the decision spread
 * across a SQL expression and a TypeScript comparator instead of in one explicit
 * place. The candidate set is one stream or one epic's worth of workable tasks,
 * which is bounded by the size of a stream, not of a workspace.
 */

/**
 * `meta.priority`, most urgent first, so the index is the rank.
 *
 * Declared here rather than imported from `schema/primitives.ts`, which the
 * `parseDocument` bypass guard keeps inside the schema layer — and which declares
 * the *values* without claiming an order, so the ranking is this service's decision
 * either way. When `ENTITY_PRIORITY` changes, update this urgency order in the same
 * change so every legal document priority remains ranked.
 */
export const PRIORITY_RANK = ["critical", "high", "medium", "low"] as const;
export type WorkPriority = (typeof PRIORITY_RANK)[number];

/**
 * A task with no `meta.priority` sorts below `low`.
 *
 * Not "treated as medium": the field may be absent because nobody decided, and a
 * task nobody prioritised should not outrank one somebody marked `low`. It still
 * appears — unprioritised work is work, and hiding it would make `get_next_work`
 * report an empty stream that is not empty.
 */
const UNPRIORITISED_RANK = PRIORITY_RANK.length;

export const WORKABLE_TASK_STATUS = [
  "ready",
  "in_progress",
] as const satisfies readonly TaskStatus[];

/** What `get_next_work` is pointed at. A task key is refused by the tool. */
export type NextWorkSubject = {
  readonly entity: "epic" | "stream";
  readonly id: string;
  readonly key: string;
};

export type NextWorkTask = {
  readonly key: string;
  readonly title: string;
  readonly taskType: TaskType;
  readonly status: TaskStatus;
  /** `null` when the document does not name one. */
  readonly priority: WorkPriority | null;
  /** The stream the task sits under, so an epic-wide answer stays readable. */
  readonly streamKey: string;
};

export type NextWorkResult = {
  readonly tasks: readonly NextWorkTask[];
  /** Workable, task-unblocked tasks before applying the response limit. */
  readonly availableCount: number;
  /** Whether `tasks` is only the most urgent prefix of `availableCount`. */
  readonly truncated: boolean;
  /** How many workable tasks were hidden because something still blocks them. */
  readonly blockedCount: number;
  /** How many streams were searched — `1` for a stream subject. */
  readonly streamCount: number;
};

export const DEFAULT_NEXT_WORK_LIMIT = 5;
export const MAX_NEXT_WORK_LIMIT = 20;

async function listNextWork(
  scope: WorkspaceScope,
  subject: NextWorkSubject,
  options: { readonly limit?: number } = {},
  executor?: DbExecutor,
): Promise<NextWorkResult> {
  const streamKeys = new Map<string, string>();
  if (subject.entity === "stream") {
    streamKeys.set(subject.id, subject.key);
  } else {
    for (const row of await streamRepository.listByEpic(scope, subject.id, executor)) {
      streamKeys.set(row.id, row.key);
    }
  }
  const streamCount = streamKeys.size;
  if (streamCount === 0) {
    return { tasks: [], availableCount: 0, truncated: false, blockedCount: 0, streamCount };
  }

  const candidates = await taskRepository.listByStreams(
    scope,
    { streamIds: [...streamKeys.keys()], statuses: WORKABLE_TASK_STATUS },
    executor,
  );
  if (candidates.length === 0) {
    return { tasks: [], availableCount: 0, truncated: false, blockedCount: 0, streamCount };
  }

  const blocked = await dependencyRepository.blockedTaskIds(
    scope,
    candidates.map((row) => row.id),
    executor,
  );
  const open = candidates.filter((row) => !blocked.has(row.id));
  const availableCount = open.length;

  const ordered = [...open]
    .sort(compareWorkable)
    .slice(0, clampLimit(options.limit))
    .map((row) => toNextWorkTask(row, streamKeys));

  return {
    tasks: ordered,
    availableCount,
    truncated: ordered.length < availableCount,
    blockedCount: candidates.length - open.length,
    streamCount,
  };
}

/**
 * Priority first, then the key's own sequence number.
 *
 * The tiebreaker is the sequence and not the key string, because keys sort
 * lexicographically and `TASK-10` would come before `TASK-2` — an ordering that
 * looks arbitrary to the reader and drifts as a project grows past ten tasks.
 * The resulting order is deterministic across repeated reads.
 */
function compareWorkable(left: Task, right: Task): number {
  const byPriority = priorityRank(left.document) - priorityRank(right.document);
  return byPriority === 0 ? sequenceOf(left.key) - sequenceOf(right.key) : byPriority;
}

const priorityRank = (document: Record<string, unknown>): number => {
  const priority = readPriority(document);
  if (priority === null) {
    return UNPRIORITISED_RANK;
  }
  return PRIORITY_RANK.indexOf(priority);
};

const readPriority = (document: Record<string, unknown>): WorkPriority | null => {
  const meta = document.meta;
  if (typeof meta !== "object" || meta === null) {
    return null;
  }
  const value = (meta as Record<string, unknown>).priority;
  return PRIORITY_RANK.find((candidate) => candidate === value) ?? null;
};

/** A key that `parseKey` cannot read sorts last; every stored key is readable. */
const sequenceOf = (key: string): number => parseKey(key)?.sequence ?? Number.MAX_SAFE_INTEGER;

const clampLimit = (limit: number | undefined): number => {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DEFAULT_NEXT_WORK_LIMIT;
  }
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_NEXT_WORK_LIMIT);
};

const toNextWorkTask = (row: Task, streamKeys: ReadonlyMap<string, string>): NextWorkTask => ({
  key: row.key,
  title: row.title,
  taskType: row.taskType,
  status: row.status,
  priority: readPriority(row.document),
  // Every candidate came out of `listByStreams` for one of these ids, so the map
  // always answers; the fallback exists so a future caller cannot get `undefined`
  // in a string field without noticing.
  streamKey: streamKeys.get(row.streamId) ?? row.streamId,
});

export const nextWorkService = { listNextWork };
