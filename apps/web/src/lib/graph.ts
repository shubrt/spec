/**
 * What the stored dependency graph can be asked at read time.
 *
 * Everything in this file is **derived**, and every surface that shows one of
 * these answers says so. That is not modesty — it is the difference between a
 * fact and an inference:
 *
 *   A **Dependency Wave** is computed here, from the edges, every time the page
 *   loads. It is not a stored entity, nothing writes it, and an equal wave means
 *   only that nothing in the graph forces an order between two Streams. It does
 *   not mean they are merge-safe, and it does not mean they are concurrently
 *   active.
 *
 *   The **longest blocker chain** is the longest path through the graph. It is
 *   never called a critical path: a critical path is the longest path weighted by
 *   duration, and this product stores no durations at all. What this counts is
 *   Streams in a row, not elapsed time.
 *
 *   A **possible scope collision** is two open Tasks that name overlapping
 *   technical scope. Nothing here has been executed, so this can never be a
 *   detected conflict — it is a warning that two pieces of work may touch the
 *   same code.
 *
 * Roadmap rank is deliberately absent from this file. It is advisory ordering
 * inside a Milestone and carries no dependency, so letting it reach the graph
 * would turn a planning preference into a prerequisite.
 */

/** One stored `blocked_by` edge: `dependent` waits for `prerequisite`. */
export interface DependencyEdge {
  readonly dependent: string;
  readonly prerequisite: string;
  readonly reason: string | null;
}

/**
 * Groups the nodes of a dependency graph into waves.
 *
 * Wave 0 holds the nodes with no prerequisite *inside the graph*; a node lands in
 * wave `k` when the deepest prerequisite it has sits in wave `k - 1`. Longest-path
 * depth rather than shortest, so a Stream never appears earlier than something it
 * genuinely waits on.
 *
 * Only nodes that take part in at least one edge are grouped. A Stream with no
 * dependency at all is not "early" — it has nothing to wait for, which is a
 * different statement, and putting it in wave 0 makes the lane claim something it
 * does not know. Those Streams are listed as what they are instead.
 *
 * A cycle is impossible through the change-set engine, which refuses to create
 * one. If one exists anyway, the nodes still inside it are returned in
 * `unresolved` rather than dropped or forced into a wave.
 */
export function dependencyWaves(edges: readonly DependencyEdge[]): {
  readonly waves: readonly (readonly string[])[];
  readonly unresolved: readonly string[];
} {
  const nodes = new Set<string>();
  const prerequisites = new Map<string, Set<string>>();
  for (const edge of edges) {
    nodes.add(edge.dependent);
    nodes.add(edge.prerequisite);
    const bucket = prerequisites.get(edge.dependent);
    if (bucket) bucket.add(edge.prerequisite);
    else prerequisites.set(edge.dependent, new Set([edge.prerequisite]));
  }

  const depth = new Map<string, number>();
  let settled = 0;
  // Each pass settles at least one node in an acyclic graph, so the loop runs at
  // most once per node — no recursion, and a cycle simply stops making progress.
  for (let pass = 0; pass < nodes.size && settled < nodes.size; pass += 1) {
    let progressed = false;
    for (const node of nodes) {
      if (depth.has(node)) continue;
      const needs = [...(prerequisites.get(node) ?? [])];
      if (needs.some((need) => !depth.has(need))) continue;
      const deepest = needs.reduce((max, need) => Math.max(max, depth.get(need) ?? 0), -1);
      depth.set(node, deepest + 1);
      settled += 1;
      progressed = true;
    }
    if (!progressed) break;
  }

  const waveCount = [...depth.values()].reduce((max, value) => Math.max(max, value + 1), 0);
  const waves = Array.from({ length: waveCount }, (): string[] => []);
  for (const [node, value] of depth) waves[value]?.push(node);
  for (const wave of waves) wave.sort();

  return {
    waves,
    unresolved: [...nodes].filter((node) => !depth.has(node)).sort(),
  };
}

/**
 * The longest path through the graph, as the sequence of nodes along it.
 *
 * Not a critical path. There are no durations to weight it with, so this is a
 * count of Streams that must happen one after another and says nothing about how
 * long that takes. Ties are broken by key so the same graph always names the same
 * chain.
 */
export function longestBlockerChain(edges: readonly DependencyEdge[]): readonly string[] {
  const dependents = new Map<string, string[]>();
  const nodes = new Set<string>();
  for (const edge of edges) {
    nodes.add(edge.dependent);
    nodes.add(edge.prerequisite);
    const bucket = dependents.get(edge.prerequisite);
    if (bucket) bucket.push(edge.dependent);
    else dependents.set(edge.prerequisite, [edge.dependent]);
  }

  const best = new Map<string, readonly string[]>();
  const walking = new Set<string>();

  const from = (node: string): readonly string[] => {
    const cached = best.get(node);
    if (cached) return cached;
    // A cycle would otherwise recurse forever. The change-set engine prevents
    // one; this makes the read path survive a graph that has one anyway.
    if (walking.has(node)) return [node];
    walking.add(node);

    let longest: readonly string[] = [node];
    for (const next of [...(dependents.get(node) ?? [])].sort()) {
      const candidate = [node, ...from(next)];
      if (candidate.length > longest.length) longest = candidate;
    }

    walking.delete(node);
    best.set(node, longest);
    return longest;
  };

  let chain: readonly string[] = [];
  for (const node of [...nodes].sort()) {
    const candidate = from(node);
    if (candidate.length > chain.length) chain = candidate;
  }
  return chain;
}

/** Everything that must finish before `node` can start, transitively. */
export function upstreamOf(edges: readonly DependencyEdge[], node: string): ReadonlySet<string> {
  return reachable(adjacency(edges, "upstream"), node);
}

/** Everything that finishing `node` would release, transitively. */
export function downstreamOf(edges: readonly DependencyEdge[], node: string): ReadonlySet<string> {
  return reachable(adjacency(edges, "downstream"), node);
}

function adjacency(
  edges: readonly DependencyEdge[],
  direction: "upstream" | "downstream",
): ReadonlyMap<string, readonly string[]> {
  const map = new Map<string, string[]>();
  for (const edge of edges) {
    const [from, to] =
      direction === "upstream"
        ? [edge.dependent, edge.prerequisite]
        : [edge.prerequisite, edge.dependent];
    const bucket = map.get(from);
    if (bucket) bucket.push(to);
    else map.set(from, [to]);
  }
  return map;
}

/** The start node is not in the result: it is the question, not an answer. */
function reachable(
  next: ReadonlyMap<string, readonly string[]>,
  start: string,
): ReadonlySet<string> {
  const seen = new Set<string>();
  const queue = [...(next.get(start) ?? [])];
  while (queue.length > 0) {
    const node = queue.pop();
    if (node === undefined || seen.has(node)) continue;
    seen.add(node);
    queue.push(...(next.get(node) ?? []));
  }
  return seen;
}

/* ------------------------------------------------------- possible collision -- */

export interface ScopedTask {
  readonly key: string;
  readonly streamKey: string;
  /** Every name from the Task's `technical_scope`, flattened. */
  readonly scope: readonly string[];
}

export interface PossibleCollision {
  readonly key: string;
  readonly left: string;
  readonly leftStream: string;
  readonly right: string;
  readonly rightStream: string;
  readonly shared: readonly string[];
}

/**
 * Pairs of open Tasks in the same derived wave whose technical scopes intersect.
 *
 * A **possible** collision, never a detected conflict: the scope lists are what
 * an author wrote down, nothing has been executed, and two Tasks naming the same
 * component may well touch different parts of it.
 *
 * Two shared names rather than one, because a single shared name is usually the
 * repository itself and would pair almost every Task with almost every other.
 * Tasks in different waves are excluded — the graph already forces an order
 * between them, so they cannot be in flight together.
 */
export function possibleCollisions(
  tasks: readonly ScopedTask[],
  waveOfStream: ReadonlyMap<string, number>,
  minimumShared = 2,
): readonly PossibleCollision[] {
  const collisions: PossibleCollision[] = [];
  for (let i = 0; i < tasks.length; i += 1) {
    const left = tasks[i];
    if (!left) continue;
    for (let j = i + 1; j < tasks.length; j += 1) {
      const right = tasks[j];
      if (!right) continue;
      if (left.streamKey === right.streamKey) continue;
      const leftWave = waveOfStream.get(left.streamKey);
      const rightWave = waveOfStream.get(right.streamKey);
      if (leftWave === undefined || rightWave === undefined || leftWave !== rightWave) continue;
      const shared = left.scope.filter((name) => right.scope.includes(name));
      if (shared.length < minimumShared) continue;
      collisions.push({
        key: `${left.key}:${right.key}`,
        left: left.key,
        leftStream: left.streamKey,
        right: right.key,
        rightStream: right.streamKey,
        shared,
      });
    }
  }
  return collisions;
}
