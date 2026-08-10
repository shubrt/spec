import { DomainError } from "../_/errors";
import {
  HIERARCHY_ENTITY_TYPE,
  VERSIONED_ENTITY_TYPE,
  type HierarchyEntityType,
  type VersionedEntityType,
} from "./enums";

/**
 * Entity keys — `E-1`, `S-12`, `T-45`, `M-2`, `R-7` — are the handle a human
 * and an agent both use to name a versioned entity (domain spec §5.3).
 *
 * ## No slug in the key
 *
 * There is deliberately no semantic part: no NFKD normalisation, no umlaut
 * transliteration, no stop-word list and therefore no collision handling. A slug
 * has to be computed from a title that is still being written, changes when the
 * title is corrected, and needs a tie-breaker as soon as two streams are called
 * something similar — three moving parts to make a key marginally more
 * readable. The title carries readability; the key only has to be short, stable
 * and unambiguous, and `search_context` is how an agent finds an entity it cannot
 * name.
 *
 * ## Where the number comes from
 *
 * The five counters on `project` hold the last number issued per entity kind,
 * and `repository/entity.ts` increments the one it needs under `SELECT … FOR
 * UPDATE` on the project row, inside the change-set transaction.
 * That is what makes two parallel agents impossible to collide without a retry
 * loop, and it is why keys are gapless per project — a rolled-back change set
 * releases the lock without having committed the increment, so the number it did
 * not use is handed to the next writer. A `MAX(key) + 1` read would produce the
 * same number and then hand it to both writers.
 *
 * A key is never reused after a delete: the counter only moves forward, so an
 * external reference to `S-12` can never quietly start pointing at a different
 * stream.
 */

/** The intentionally terse, non-semantic prefix per versioned entity type. */
export const KEY_PREFIX = {
  epic: "E",
  stream: "S",
  task: "T",
  milestone: "M",
  rule: "R",
} as const satisfies Record<VersionedEntityType, string>;

/** Prefix → entity, derived so the two directions cannot drift apart. */
const VERSIONED_ENTITY_BY_PREFIX = new Map<string, VersionedEntityType>(
  VERSIONED_ENTITY_TYPE.map((entity) => [KEY_PREFIX[entity], entity]),
);

const HIERARCHY_ENTITY = new Set<VersionedEntityType>(HIERARCHY_ENTITY_TYPE);

const isHierarchyEntityType = (entity: VersionedEntityType): entity is HierarchyEntityType =>
  HIERARCHY_ENTITY.has(entity);

/** `formatKey("stream", 12)` → `"S-12"`. */
export function formatKey(entity: VersionedEntityType, sequence: number): string {
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    // A key derived from a bad counter would look plausible and be permanent, so
    // this throws rather than clamping. It is unreachable through the repository,
    // where the value comes from a `NOT NULL DEFAULT 0` integer column.
    throw new DomainError(
      "invalid_key_sequence",
      `Key sequence for ${entity} must be a positive integer, received ${sequence}.`,
    );
  }
  return `${KEY_PREFIX[entity]}-${sequence}`;
}

/**
 * Parses any versioned-entity key: `"R-12"` becomes
 * `{ entity: "rule", sequence: 12 }`.
 *
 * Strict on purpose: no lower case, no leading zeros, no whitespace. A key is
 * server-generated, so anything that only nearly matches was not generated here.
 */
export function parseVersionedKey(
  value: string,
): { entity: VersionedEntityType; sequence: number } | null {
  const match = /^([A-Z]+)-([1-9][0-9]*)$/.exec(value);
  if (!match) {
    return null;
  }
  const entity = VERSIONED_ENTITY_BY_PREFIX.get(match[1] ?? "");
  if (!entity) {
    return null;
  }
  return { entity, sequence: Number(match[2]) };
}

/**
 * Parses only ownership-hierarchy keys. Rule and Milestone callers use
 * `parseVersionedKey`; this narrower boundary prevents an `R-1` from reaching an
 * exhaustive Epic/Stream/Task switch.
 */
export function parseHierarchyKey(
  value: string,
): { entity: HierarchyEntityType; sequence: number } | null {
  const parsed = parseVersionedKey(value);
  return parsed && isHierarchyEntityType(parsed.entity)
    ? { entity: parsed.entity, sequence: parsed.sequence }
    : null;
}
