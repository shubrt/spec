import { DomainError } from "../_/errors";
import { ENTITY_TYPE, type EntityType } from "./enums";

/**
 * Entity keys — `EPIC-1`, `STR-12`, `TASK-45` — the handle a human and an agent
 * both use to name an entity (domain spec §5.3).
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
 * `project.epic_counter` / `stream_counter` / `task_counter` hold the last number
 * issued, and `repository/entity.ts` increments the one it needs under
 * `SELECT … FOR UPDATE` on the project row, inside the change-set transaction.
 * That is what makes two parallel agents impossible to collide without a retry
 * loop, and it is why keys are gapless per project — a rolled-back change set
 * releases the lock without having committed the increment, so the number it did
 * not use is handed to the next writer. A `MAX(key) + 1` read would produce the
 * same number and then hand it to both writers.
 *
 * A key is never reused after a delete: the counter only moves forward, so an
 * external reference to `STR-12` can never quietly start pointing at a different
 * stream.
 */

/**
 * The prefix per entity type. `STR` rather than `STREAM` because a stream key is
 * the one an agent types most often; `EPIC` and `TASK` are already short.
 */
export const KEY_PREFIX = {
  epic: "EPIC",
  stream: "STR",
  task: "TASK",
} as const satisfies Record<EntityType, string>;

export type KeyPrefix = (typeof KEY_PREFIX)[EntityType];

/** Prefix → entity, derived so the two directions cannot drift apart. */
const ENTITY_BY_PREFIX = new Map<string, EntityType>(
  ENTITY_TYPE.map((entity) => [KEY_PREFIX[entity], entity]),
);

/** `formatKey("stream", 12)` → `"STR-12"`. */
export function formatKey(entity: EntityType, sequence: number): string {
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
 * The inverse: `"STR-12"` → `{ entity: "stream", sequence: 12 }`, and `null` for
 * anything that is not a key.
 *
 * Returning `null` rather than throwing is the point of this function: a change
 * set hands over strings an agent typed, and "this is not a key" is an answer the
 * caller acts on — `changeSet/plan.ts` uses it to tell a mistyped key apart from a
 * temp id, and to route a key to the right repository without a second lookup.
 *
 * Strict on purpose: no lower case, no leading zeros, no whitespace. A key is
 * server-generated, so anything that only nearly matches was not generated here.
 */
export function parseKey(value: string): { entity: EntityType; sequence: number } | null {
  const match = /^([A-Z]+)-([1-9][0-9]*)$/.exec(value);
  if (!match) {
    return null;
  }
  const entity = ENTITY_BY_PREFIX.get(match[1] ?? "");
  if (!entity) {
    return null;
  }
  return { entity, sequence: Number(match[2]) };
}
