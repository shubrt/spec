import type {
  Aggregate,
  EpicNode,
  MilestoneNode,
  RuleNode,
  StreamNode,
  TaskNode,
} from "~/server/board";

/**
 * The entity named by a standalone detail route.
 *
 * Route parameters use the stable, human-readable key rather than the database
 * id used by drawers. The entity kind remains explicit so `/epic/S-1` cannot
 * accidentally resolve a stream whose key happens to match the path segment.
 */
export type EntityDetailReference =
  | { readonly kind: "epic"; readonly key: string }
  | { readonly kind: "stream"; readonly key: string }
  | { readonly kind: "task"; readonly key: string }
  | { readonly kind: "milestone"; readonly key: string }
  | { readonly kind: "rule"; readonly key: string };

/** The result of resolving one detail-route reference against a project aggregate. */
export type EntityDetailTarget =
  | { readonly kind: "missing" }
  | { readonly kind: "epic"; readonly epic: EpicNode }
  | { readonly kind: "stream"; readonly stream: StreamNode }
  | { readonly kind: "task"; readonly task: TaskNode; readonly stream: StreamNode }
  | { readonly kind: "milestone"; readonly milestone: MilestoneNode }
  | { readonly kind: "rule"; readonly rule: RuleNode };

/**
 * Resolves a public detail-route key from the aggregate already in memory.
 *
 * Keys are compared exactly. An edited, stale, wrongly-cased, or wrong-kind URL
 * is an ordinary missing result; resolving it never causes another request.
 */
export function resolveEntityDetail(
  aggregate: Aggregate,
  reference: EntityDetailReference,
): EntityDetailTarget {
  if (reference.kind === "rule") {
    const rule = aggregate.rules.find((candidate) => candidate.key === reference.key);
    return rule ? { kind: "rule", rule } : { kind: "missing" };
  }

  if (reference.kind === "milestone") {
    const milestone = aggregate.milestones.find((candidate) => candidate.key === reference.key);
    return milestone ? { kind: "milestone", milestone } : { kind: "missing" };
  }

  const { epics } = aggregate;
  if (reference.kind === "epic") {
    const epic = epics.find((candidate) => candidate.key === reference.key);
    return epic ? { kind: "epic", epic } : { kind: "missing" };
  }

  for (const epic of epics) {
    for (const stream of epic.streams) {
      if (reference.kind === "stream" && stream.key === reference.key) {
        return { kind: "stream", stream };
      }

      if (reference.kind === "task") {
        const task = stream.tasks.find((candidate) => candidate.key === reference.key);
        if (task) return { kind: "task", task, stream };
      }
    }
  }

  return { kind: "missing" };
}
