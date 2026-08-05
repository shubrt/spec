/**
 * Cycle detection over a project's dependency edges — the enforcement site for
 * the domain spec §11 rule `dependencies_must_be_acyclic`.
 *
 * ## Why this is in memory and not a recursive CTE
 *
 * A project's dependency count is two-digit: an epic holds a handful of streams,
 * a stream a handful of tasks, and only a fraction of them declare a blocker. One
 * `SELECT` of the project's `blocked_by` rows costs a single index scan, and the
 * check itself is then a few hundred pointer hops. A `WITH RECURSIVE` query would
 * be the same asymptotics while coupling this pure graph operation to storage.
 *
 * Keep it that way. The moment this module imports `integration/drizzle`, every
 * caller needs a live Postgres, and the pipeline's "would this change set introduce
 * a cycle?" question — which has to be answered on edges that do not exist in the
 * database yet — becomes unanswerable.
 *
 * ## Why only `blocked_by`
 *
 * `related_to`, `extends`, `fixes` and `supersedes` are annotations: they say
 * something about two entities without claiming an order between them, so a loop
 * of them is not a contradiction. `blocked_by` is the one relationship that
 * claims "this cannot start before that", and a loop of those claims is
 * unsatisfiable work. `entityLinkRepository.edgesForProject` therefore reads only
 * `blocked_by` rows, and this function takes whatever it is given — filtering is
 * the repository's job, so a caller cannot accidentally widen it here.
 */

/**
 * One dependency, in the direction "cannot start before": `from` is blocked and
 * `to` is the blocker. Node identity is the entity's uuid, which is unique across
 * `epic`, `stream` and `task`, so no type prefix is needed to keep two entities
 * apart.
 */
export type DependencyEdge = {
  /** The dependent — the entity that is blocked. */
  readonly from: string;
  /** The blocker — the entity that has to land first. */
  readonly to: string;
};

/**
 * The nodes of one cycle in dependency order, with the entry node repeated at the
 * end: `["a", "b", "a"]` reads as "a is blocked by b is blocked by a". A self-link
 * is `["a", "a"]`.
 *
 * The repeated node is not redundant: an error message has to show a closed loop,
 * and `["a", "b"]` alone does not say whether the loop closes at `a`.
 */
export type DependencyCycle = readonly string[];

/**
 * The first cycle in `edges`, or `null` when the graph is acyclic.
 *
 * "First" is deterministic and defined by the input order: nodes are visited in
 * the order they first appear as an edge's `from`, then as an edge's `to`, and
 * each node's successors in the order their edges were given. A repository that
 * returns edges in a stable order therefore produces a stable error message, so
 * the same broken change set does not name a different pair of entities on every
 * attempt.
 *
 * Only the first cycle is reported. Finding every cycle is exponential in the
 * worst case, and an agent that has to break one edge is not helped by a list —
 * once that edge is gone, the next call reports the next cycle.
 */
export function findDependencyCycle(edges: readonly DependencyEdge[]): DependencyCycle | null {
  const successors = new Map<string, string[]>();
  // Insertion order of a Map is iteration order, so building this in edge order
  // is what makes the traversal — and therefore the reported cycle — stable.
  for (const edge of edges) {
    const existing = successors.get(edge.from);
    if (existing) {
      existing.push(edge.to);
    } else {
      successors.set(edge.from, [edge.to]);
    }
    if (!successors.has(edge.to)) {
      successors.set(edge.to, []);
    }
  }

  /** Nodes whose whole subtree is known to be acyclic; never revisited. */
  const settled = new Set<string>();
  /** The current depth-first path, as a set for O(1) "is this a back edge?". */
  const onPath = new Set<string>();
  const path: string[] = [];

  const walk = (node: string): DependencyCycle | null => {
    if (onPath.has(node)) {
      // A back edge closes the loop. Cut the path at the node we came back to so
      // the result is the cycle itself and not the road that led to it. A
      // self-link (`from === to`) lands here on the first hop and yields
      // `[a, a]`, so the `check("entity_link_no_self")` in the database has a
      // pure counterpart that does not need one.
      return [...path.slice(path.indexOf(node)), node];
    }
    if (settled.has(node)) {
      return null;
    }
    onPath.add(node);
    path.push(node);
    for (const next of successors.get(node) ?? []) {
      const cycle = walk(next);
      if (cycle) {
        return cycle;
      }
    }
    path.pop();
    onPath.delete(node);
    // Marked only after the whole subtree came back clean, which is what turns
    // the diamond `a→b, a→c, b→d, c→d` into two visits of `d` instead of a
    // second traversal of it — and what keeps a shared subgraph from being
    // mistaken for a loop.
    settled.add(node);
    return null;
  };

  for (const node of successors.keys()) {
    const cycle = walk(node);
    if (cycle) {
      return cycle;
    }
  }
  return null;
}
