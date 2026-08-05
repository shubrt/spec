import type { WorkspaceScope } from "../auth/workspaceScope";
import { type Epic, epicRepository } from "../repository/epic";
import { type Stream, streamRepository } from "../repository/stream";
import { type Task, taskRepository } from "../repository/task";
import { type Project, workspaceRepository } from "../repository/workspace";

/**
 * The whole planning tree of one project, in a fixed four queries.
 *
 * ## Why an aggregate at all
 *
 * The web UI is a read-only window that filters and sorts client-side, so it
 * wants the board in one response rather than a request per panel. This is the
 * shape that makes the project overview, the epic list and the stream/task
 * detail drawer all readable from a single Treaty call.
 *
 * ## The query count is the design, and it is pinned by a test
 *
 * **Four queries for a project that exists, one for a project that does not.**
 * Never a function of the tree's size.
 *
 * The naive version of this reads epics, then streams per epic, then tasks per
 * stream — 1 + E + E×S queries, which is a handful in a test fixture and a
 * hundred on a real board. It is avoided by reading each level as one flat
 * per-project list (`workspace_id`/`project_id` are denormalised onto every
 * child row precisely so that is possible) and doing the parent/child grouping
 * in memory, where it costs nothing.
 *
 * `test/db/projectAggregate.db.test.ts` counts the real SQL statements against
 * Postgres and asserts exactly that, including with a tree big enough that an
 * N+1 would show up. Growing this function by one more per-parent read is
 * therefore a failing test, not a slow page nobody notices.
 *
 * The project row is read first and on its own, so a project that does not exist
 * — or belongs to another tenant — costs one query and not four.
 *
 * ## Tenancy
 *
 * Every one of the four reads is a repository call taking `scope` as its first
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

export type ProjectAggregate = {
  readonly project: Project;
  readonly epics: readonly EpicNode[];
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

  // The three level reads do not depend on one another — each filters on
  // `(workspace_id, project_id)` directly — so they go out together and cost one
  // round trip's latency rather than three.
  const [epics, streams, tasks] = await Promise.all([
    epicRepository.listByProject(scope, projectId),
    streamRepository.listByProject(scope, projectId),
    taskRepository.listByProject(scope, projectId),
  ]);

  const streamsByEpic = groupBy(streams, (row) => row.epicId);
  const tasksByStream = groupBy(tasks, (row) => row.streamId);

  return {
    project,
    // A child whose parent is not in this project cannot occur: `move` relocates
    // a whole subtree in one transaction (`test/db/move.db.test.ts`), so a stream
    // and its epic are always in the same project. The grouping is written to
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
