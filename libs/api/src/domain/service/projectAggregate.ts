import type { WorkspaceScope } from "../auth/workspaceScope";
import type { LinkableEntityType, RelationshipType } from "../enums";
import { entityLinkRepository } from "../repository/entityLink";
import { type Epic, epicRepository } from "../repository/epic";
import { type Milestone, milestoneRepository } from "../repository/milestone";
import { projectFragmentRepository } from "../repository/projectFragment";
import { type Rule, ruleRepository } from "../repository/rule";
import { type Stream, streamRepository } from "../repository/stream";
import { type Task, taskRepository } from "../repository/task";
import { type Project, workspaceRepository } from "../repository/workspace";

/**
 * The whole readable project model, in a fixed eight queries.
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
 * **Eight queries for a project that exists, one for a project that does not.**
 * Never a function of the tree's size.
 *
 * The naive version reads epics, then streams per epic, tasks per stream, and
 * assigned streams per milestone. That grows with the board. It is avoided by
 * reading every entity kind as one flat per-project list and assembling both
 * the E→S→T ownership tree and the parallel roadmap in memory.
 *
 * The project row is read first and on its own, so a project that does not exist
 * — or belongs to another tenant — costs one query and not eight.
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

/**
 * One stored link, both endpoints named by their public key.
 *
 * `relationship` is carried verbatim rather than reduced to "blocks / does not
 * block": `blocked_by` claims an order and the other six do not, and a reader has
 * to be able to tell a prerequisite from an `extends` at a glance. Collapsing them
 * would let a semantic relation be drawn as a blocker.
 *
 * Stored direction only. `entity_link` holds `blocked_by` and never `blocks`, so
 * `source` is the *dependent* and `target` is the *prerequisite*; a consumer that
 * wants the other direction reverses the pair rather than reading a second row
 * that could disagree with the first.
 */
export type ProjectLink = {
  readonly sourceType: LinkableEntityType;
  readonly sourceKey: string;
  readonly targetType: LinkableEntityType;
  readonly targetKey: string;
  readonly relationship: RelationshipType;
  /** Why this link exists, in the author's words (domain spec §5.5). */
  readonly reason: string | null;
};

export type ProjectAggregate = {
  readonly project: Project;
  readonly fragmentCount: number;
  readonly epics: readonly EpicNode[];
  readonly milestones: readonly MilestoneNode[];
  readonly rules: readonly Rule[];
  readonly links: readonly ProjectLink[];
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
  // round trip's latency rather than six.
  const [epics, streams, tasks, milestones, rules, links, fragmentCount] = await Promise.all([
    epicRepository.listByProject(scope, projectId),
    streamRepository.listByProject(scope, projectId),
    taskRepository.listByProject(scope, projectId),
    milestoneRepository.listByProject(scope, projectId),
    ruleRepository.listByProject(scope, projectId),
    entityLinkRepository.listByProject(scope, projectId),
    projectFragmentRepository.countByProject(scope, projectId),
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

  // `entity_link` endpoints carry no foreign key, so a link can outlive the
  // entity it points at — the change-set engine owns that cleanup, and a read
  // path must not answer "blocked by" with a row it cannot name. An edge with an
  // unresolvable end is dropped here rather than surfaced with a blank key.
  const keyById = new Map<string, string>();
  for (const row of [...epics, ...streams, ...tasks, ...rules]) {
    keyById.set(row.id, row.key);
  }

  return {
    project,
    fragmentCount,
    rules,
    links: links.flatMap((row) => {
      const sourceKey = keyById.get(row.sourceId);
      const targetKey = keyById.get(row.targetId);
      if (sourceKey === undefined || targetKey === undefined) return [];
      return [
        {
          sourceType: row.sourceType,
          sourceKey,
          targetType: row.targetType,
          targetKey,
          relationship: row.relationshipType,
          reason: row.reason,
        },
      ];
    }),
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
