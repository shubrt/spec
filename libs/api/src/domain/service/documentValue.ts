/**
 * Reading an untyped stored document.
 *
 * Every read here is a coercion, not a cast. A document reaches a read path as
 * `Record<string, unknown>` on purpose — the read surface is a *window*, and a
 * document written before a schema change has to stay readable rather than becoming
 * a 422 on a projection that only wants to display it. `parseDocument` in
 * `domain/schema/` is where a document is held to its schema; this is the other
 * side, where whatever is stored is read defensively.
 *
 * These existed inline in three services before. One definition, because a coercion
 * that disagrees with its copy is a bug nobody can see.
 */

/** Any value `JSON.parse` can produce. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** A JSON object — what a document and each of its sections actually is. */
export type JsonObject = { [key: string]: JsonValue };

/** A JSON object, or `{}` for anything that is not one. Arrays are not objects here. */
export const asRecord = (value: unknown): JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : {};

/**
 * A JSON array, or `[]`. The element type is the caller's claim, unchecked — every
 * consumer treats elements as all-optional shapes for exactly that reason.
 */
export const asArray = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);

/** A string, or `""`. */
export const asText = (value: unknown): string => (typeof value === "string" ? value : "");

/** A string, or `null` — for a field whose absence is meaningful. */
export const optionalText = (value: unknown): string | null => {
  const text = asText(value);
  return text.length > 0 ? text : null;
};

/**
 * The strings of an array, dropping anything that is not one.
 *
 * Dropping rather than stringifying: a `[{…}]` where `["FR-1"]` belongs is a data
 * fault, and rendering it as `[object Object]` inside a reference list would present
 * it as a reference that exists.
 */
export const asTextArray = (value: unknown): readonly string[] =>
  asArray<unknown>(value).filter((item): item is string => typeof item === "string");

/** A finite number, or `null` — so `0` survives and `NaN` does not. */
export const asNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/** The envelope's `content`. `meta`, `links`, `execution` and `provenance` are siblings. */
export const contentOf = (document: Record<string, unknown>): JsonObject =>
  asRecord(document.content);
