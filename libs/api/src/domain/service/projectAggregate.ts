import type { WorkspaceScope } from "../auth/workspaceScope";
import { type Epic, epicRepository } from "../repository/epic";
import { type Milestone, milestoneRepository } from "../repository/milestone";
import { type Rule, ruleRepository } from "../repository/rule";
import { type Stream, streamRepository } from "../repository/stream";
import { type Task, taskRepository } from "../repository/task";
import { type Project, workspaceRepository } from "../repository/workspace";

/**
 * The whole readable project model, in a fixed six queries.
 *
 * ## Why an aggregate at all
 *
 * The web UI is a read-only window that filters and sorts client-side, so it
 * wants the board in one response rather than a request per panel. This is the
 * shape that makes the project overview, the epic list and the stream/task
 * detail drawer all readable from a single Treaty call.
 *
 * ## The query count is part of the design
 *
 * **Six queries for a project that exists, one for a project that does not.**
 * Never a function of the tree's size.
 *
 * The naive version reads epics, then streams per epic, tasks per stream, and
 * assigned streams per milestone. That grows with the board. It is avoided by
 * reading every entity kind as one flat per-project list and assembling both
 * the E→S→T ownership tree and the parallel roadmap in memory.
 *
 * The project row is read first and on its own, so a project that does not exist
 * — or belongs to another tenant — costs one query and not six.
 *
 * ## Tenancy
 *
 * Every read is a repository call taking `scope` as its first
 * argument. This function never assembles a filter and never sees a workspace id
 * from a request.
 */

export type TaskNode = Task;

export type StreamNode = {
  readonly stream: Stream;
  readonly tasks: readonly TaskNode[];
};

export type EpicNode = {
  readonly epic: Epic;
  readonly streams: readonly StreamNode[];
};

export type MilestoneStreamNode = {
  readonly id: string;
  readonly key: string;
  readonly title: string;
  readonly status: Stream["status"];
  readonly streamType: Stream["streamType"];
  readonly epicKey: string;
  readonly roadmapRank: number | null;
};

export type MilestoneNode = {
  readonly milestone: Milestone;
  /** Compact references only: ownership remains exclusively in `epics`. */
  readonly streams: readonly MilestoneStreamNode[];
};

export type ProjectAggregate = {
  readonly project: Project;
  readonly epics: readonly EpicNode[];
  readonly milestones: readonly MilestoneNode[];
  readonly rules: readonly Rule[];
};

/**
 * Groups rows under the parent id they name, preserving the order the rows
 * arrived in so the repositories' `ORDER BY` survives the grouping.
 */
function groupBy<Row>(rows: readonly Row[], parentIdOf: (row: Row) => string): Map<string, Row[]> {
  const grouped = new Map<string, Row[]>();
  for (const row of rows) {
    const key = parentIdOf(row);
    const bucket = grouped.get(key);
    if (bucket) {
      bucket.push(row);
    } else {
      grouped.set(key, [row]);
    }
  }
  return grouped;
}

/**
 * Returns `null` when the project does not exist in this scope — the caller
 * turns that into a 404. Nothing below the project is read in that case.
 */
export async function loadProjectAggregate(
  scope: WorkspaceScope,
  projectId: string,
): Promise<ProjectAggregate | null> {
  const project = await workspaceRepository.findProject(scope, projectId);
  if (!project) return null;

  // The entity reads do not depend on one another — each filters on
  // `(workspace_id, project_id)` directly — so they go out together and cost one
  // round trip's latency rather than five.
  const [epics, streams, tasks, milestones, rules] = await Promise.all([
    epicRepository.listByProject(scope, projectId),
    streamRepository.listByProject(scope, projectId),
    taskRepository.listByProject(scope, projectId),
    milestoneRepository.listByProject(scope, projectId),
    ruleRepository.listByProject(scope, projectId),
  ]);

  const streamsByEpic = groupBy(streams, (row) => row.epicId);
  const tasksByStream = groupBy(tasks, (row) => row.streamId);
  const epicKeyById = new Map(epics.map((row) => [row.id, row.key]));
  const streamsByMilestone = new Map<string, MilestoneStreamNode[]>();

  for (const row of streams) {
    if (row.milestoneId === null) continue;
    const epicKey = epicKeyById.get(row.epicId);
    if (epicKey === undefined) continue;
    const compact = {
      id: row.id,
      key: row.key,
      title: row.title,
      status: row.status,
      streamType: row.streamType,
      epicKey,
      roadmapRank: row.roadmapRank,
    };
    const bucket = streamsByMilestone.get(row.milestoneId);
    if (bucket) bucket.push(compact);
    else streamsByMilestone.set(row.milestoneId, [compact]);
  }

  for (const rows of streamsByMilestone.values()) {
    // Array sorting is stable: equal ranks retain the repository's created/key
    // order and still visibly represent parallel roadmap work.
    rows.sort(
      (left, right) =>
        (left.roadmapRank ?? Number.MAX_SAFE_INTEGER) -
        (right.roadmapRank ?? Number.MAX_SAFE_INTEGER),
    );
  }

  return {
    project,
    rules,
    milestones: milestones.map((milestoneRow) => ({
      milestone: milestoneRow,
      streams: streamsByMilestone.get(milestoneRow.id) ?? [],
    })),
    // A child whose parent is not in this project cannot occur: `move` relocates
    // a whole subtree in one transaction, so a stream and its epic are always in
    // the same project. The grouping is written to
    // drop such a row rather than invent a parent for it — an orphan is a data
    // bug, and inventing a place for it on the board would hide it.
    epics: epics.map((epicRow) => ({
      epic: epicRow,
      streams: (streamsByEpic.get(epicRow.id) ?? []).map((streamRow) => ({
        stream: streamRow,
        tasks: tasksByStream.get(streamRow.id) ?? [],
      })),
    })),
  };
}
