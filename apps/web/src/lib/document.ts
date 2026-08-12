/**
 * Reading the entity `document`, which arrives untyped.
 *
 * The aggregate types every `document` as `Record<string, unknown>` on purpose:
 * the endpoint is a window, and a document written before a schema change has to
 * stay readable rather than becoming a 422 on a page that only displays it.
 *
 * So every read here is a coercion, not a cast. A section may be absent, or
 * present with the wrong shape, and the failure mode matters: a non-string
 * reaching JSX crashes React with "Objects are not valid as a React child",
 * which would take a whole page down over one malformed field.
 *
 * The named shapes these coercions feed live in `lib/fragments.ts`.
 */

/** Any value `JSON.parse` can produce. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** A JSON object — what a `document` and each of its sections actually is. */
export type JsonObject = { [key: string]: JsonValue };

/**
 * Restates a type with every `unknown` leaf as {@link JsonValue}.
 *
 * The API types `document` as `Record<string, unknown>`, and TanStack Start
 * refuses to return `unknown` from a server function — correctly, since it
 * cannot know that an arbitrary `unknown` survives serialisation. But this value
 * came out of `JSON.parse`, so it demonstrably can.
 *
 * Applied mechanically rather than by hand-writing the aggregate's types, which
 * keeps Eden's guarantee intact: a field the server renames or drops is still a
 * type error in the components that read it.
 */
export type Jsonified<T> = unknown extends T
  ? JsonValue
  : T extends (infer Element)[]
    ? Jsonified<Element>[]
    : T extends object
      ? { [Key in keyof T]: Jsonified<T[Key]> }
      : T;

/** A JSON object, or `{}` for anything that is not one. Arrays are not objects here. */
export function asRecord(value: unknown): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

/**
 * A JSON array, or `[]`.
 *
 * The element type is the caller's claim, unchecked — every consumer treats
 * elements as all-optional shapes for exactly that reason.
 */
export function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/** A string, or `""`. The guard that keeps a malformed field from reaching JSX. */
export function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * The strings of an array, dropping anything that is not one.
 *
 * Dropping rather than stringifying: a `[{...}]` where `["FR-1"]` belongs is a
 * data fault, and rendering it as `[object Object]` inside a reference list would
 * present it as a reference that exists.
 */
export function asTextArray(value: unknown): readonly string[] {
  return asArray<unknown>(value).filter((item): item is string => typeof item === "string");
}

/** A finite number, or `null` — so `0` survives and `NaN` does not. */
export function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * The document envelope's `content` section, which is where every specification
 * section lives. `meta`, `links`, `execution` and `provenance` are siblings of
 * it, not part of it.
 */
export function contentOf(document: JsonObject): JsonObject {
  return asRecord(document.content);
}

/** The `meta` tier: title, status, priority, and the server-owned identity fields. */
export function metaOf(document: JsonObject): JsonObject {
  return asRecord(document.meta);
}

/** The Task-only `execution` section: estimate, assignee, executor kind. */
export function executionOf(document: JsonObject): JsonObject {
  return asRecord(document.execution);
}
