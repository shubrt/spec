export const SOURCE_FRESHNESS = ["fresh", "stale", "unknown"] as const;
export type SourceFreshness = (typeof SOURCE_FRESHNESS)[number];

export type SourceFreshnessInput = {
  readonly id: string;
  readonly supersedes_source_ids?: readonly string[];
};

/**
 * Derives freshness from an explicit, versioned Source supersession graph.
 *
 * A replacement is known fresh until another Source replaces it; an explicitly
 * replaced Source is stale. Standalone observations remain unknown — absence of
 * contrary evidence is not proof that an external fact is still current.
 */
export function deriveSourceFreshness(
  sources: readonly SourceFreshnessInput[],
): ReadonlyMap<string, SourceFreshness> {
  const superseded = new Set(sources.flatMap((source) => source.supersedes_source_ids ?? []));
  return new Map(
    sources.map((source) => [
      source.id,
      superseded.has(source.id)
        ? "stale"
        : (source.supersedes_source_ids?.length ?? 0) > 0
          ? "fresh"
          : "unknown",
    ]),
  );
}

/** Collects local Source ids cited by projected claim data. */
export function citedSourceIds(value: unknown): ReadonlySet<string> {
  const found = new Set<string>();
  const visit = (candidate: unknown): void => {
    if (Array.isArray(candidate)) {
      candidate.forEach(visit);
      return;
    }
    if (typeof candidate !== "object" || candidate === null) return;
    for (const [key, child] of Object.entries(candidate as Record<string, unknown>)) {
      if (key === "source_ids" && Array.isArray(child)) {
        child.forEach((id) => {
          if (typeof id === "string") found.add(id);
        });
      } else {
        visit(child);
      }
    }
  };
  visit(value);
  return found;
}

/**
 * Keeps cited Sources plus the connected supersession chain needed to explain
 * their freshness. Output order remains the document's stable source order.
 */
export function relevantSources<Source extends SourceFreshnessInput>(
  sources: readonly Source[],
  projectedClaims: unknown,
): readonly Source[] {
  const relevant = new Set(citedSourceIds(projectedClaims));
  if (relevant.size === 0) return [];

  let changed = true;
  while (changed) {
    changed = false;
    for (const source of sources) {
      const predecessors = source.supersedes_source_ids ?? [];
      if (relevant.has(source.id) || predecessors.some((id) => relevant.has(id))) {
        for (const id of [source.id, ...predecessors]) {
          if (!relevant.has(id)) {
            relevant.add(id);
            changed = true;
          }
        }
      }
    }
  }
  return sources.filter((source) => relevant.has(source.id));
}
