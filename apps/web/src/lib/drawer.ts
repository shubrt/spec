import type { EpicNode, StreamNode, TaskNode } from "~/server/board";

/**
 * Resolving `?stream=` / `?task=` against the aggregate already in memory.
 *
 * The drawer is driven by the URL rather than by component state, so these ids
 * arrive from somewhere a human can edit and from links that may be weeks old.
 * That makes "no longer here" an ordinary outcome rather than an error, and it is
 * the reason this is a pure function with tests instead of a lookup inlined into
 * the component.
 */

export type DrawerTarget =
  | { readonly kind: "closed" }
  | { readonly kind: "missing" }
  | { readonly kind: "stream"; readonly stream: StreamNode }
  | { readonly kind: "task"; readonly task: TaskNode; readonly stream: StreamNode | undefined };

export interface DrawerParams {
  readonly stream?: string;
  readonly task?: string;
}

/**
 * Picks what the drawer shows.
 *
 * `task` wins over `stream` when both are present: the task is the more specific
 * of the two, and the task view links back to its stream, so nothing is
 * unreachable. A parameter naming something the project does not contain resolves
 * to `missing` — the drawer opens and says so, rather than silently ignoring a
 * link someone deliberately followed.
 */
export function resolveDrawer(epics: readonly EpicNode[], params: DrawerParams): DrawerTarget {
  if (!params.task && !params.stream) return { kind: "closed" };

  const streams = epics.flatMap((epic) => epic.streams);

  if (params.task) {
    for (const stream of streams) {
      const task = stream.tasks.find((candidate) => candidate.id === params.task);
      // The parent is carried through rather than looked up again from
      // `task.streamId`, because finding the task already told us which stream
      // it was under.
      if (task) return { kind: "task", task, stream };
    }
    return { kind: "missing" };
  }

  const stream = streams.find((candidate) => candidate.id === params.stream);
  return stream ? { kind: "stream", stream } : { kind: "missing" };
}
