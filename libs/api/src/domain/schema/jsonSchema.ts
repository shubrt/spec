import { z } from "zod";
import {
  DOCUMENT_SCHEMAS,
  DOCUMENT_SCHEMA_TARGETS,
  type DocumentSchemaTarget,
  type DocumentSource,
} from "./document";

/**
 * Zod → JSON Schema, with the two corrections Zod 4.4.3 needs.
 *
 * Everything the model ever sees of this domain is produced here: the MCP tool
 * input schemas, the payload of `get_entity_schema`, the `zpecs://schema/*`
 * resources and the OpenAPI component shapes. That makes this file a *behaviour*
 * surface, not just a serialization detail — schema size is re-sent on every turn
 * and field descriptions are the only place several domain rules exist at all.
 *
 * ## Measured facts about Zod 4.4.3 that shape this file
 *
 * - `z.date()` **throws** `Date cannot be represented in JSON Schema`. Every
 *   timestamp in this layer is therefore `z.iso.datetime()`.
 * - `z.iso.datetime()` emits `format: "date-time"` *and* a redundant `pattern`
 *   that re-implements leap-year arithmetic in a regex. Measured length on this
 *   version: **261 characters**, not the ~400 the plan recorded — the correction
 *   does not change the decision, since the pattern is stripped either way by
 *   `jsonSchemaOverride` below. `format` already says everything, and the regex is
 *   pure token cost repeated per timestamp field.
 * - `.refine()` / `.superRefine()` are silently dropped. Nothing in this layer
 *   relies on them; the cross-field rules live in `readiness.ts` and are mirrored
 *   into `description` text (see `rules.ts`).
 * - `io: "input"` strips `additionalProperties: false` from a plain `z.object()`
 *   but keeps it on `z.strictObject()`, which is why this layer uses
 *   `strictObject` without exception.
 */

/**
 * The `override` hook, run once per generated node.
 *
 * It only ever *removes* the redundant `pattern` next to `format: "date-time"`.
 * Deliberately narrow: an override that rewrote types would put a second,
 * unvalidated schema definition next to the Zod one, which is the drift this
 * whole layer exists to prevent.
 */
export const jsonSchemaOverride = (ctx: { readonly jsonSchema: Record<string, unknown> }): void => {
  if (ctx.jsonSchema.format === "date-time" && typeof ctx.jsonSchema.pattern === "string") {
    delete ctx.jsonSchema.pattern;
  }
};

/**
 * The single conversion used everywhere.
 *
 * `io` defaults to `"input"` because every consumer that matters — tool input
 * schemas, `get_entity_schema` — describes what an agent may *write*.
 */
export const toJsonSchema = (
  schema: z.ZodType,
  io: "input" | "output" = "input",
): Record<string, unknown> =>
  z.toJSONSchema(schema, { io, override: jsonSchemaOverride }) as Record<string, unknown>;

/**
 * The size of a generated schema as it goes over the wire.
 *
 * Exists as a function because it is an acceptance criterion, not a curiosity:
 * tool input schemas are re-sent on every single turn, so a schema that grows by
 * a kilobyte costs that kilobyte per turn for the life of the session. The
 * change-set tool schema has a hard budget of 3 KB, and once that schema exists
 * (a later increment) checking it is `jsonSchemaBytes(toJsonSchema(changeSet))`.
 *
 * `TextEncoder` rather than `Buffer.byteLength`: this measures UTF-8 bytes, which
 * is what the transport counts, and it is a web standard, so it needs no Node
 * globals in a package whose runtime is Bun and whose MCP transport is
 * deliberately `node:`-free.
 */
const utf8 = new TextEncoder();

export const jsonSchemaBytes = (jsonSchema: unknown): number =>
  utf8.encode(JSON.stringify(jsonSchema)).length;

/**
 * The document schema for one target, as the model sees it.
 *
 * `source` defaults to `"agent"`: `get_entity_schema` answers "what may I write",
 * and handing an agent the stored schema would advertise `meta.revision` and
 * `meta.id` as writable fields, teaching it to attempt exactly the forgery the
 * `metaInput` / `metaStored` split exists to block.
 */
export const documentJsonSchema = (
  target: DocumentSchemaTarget,
  source: DocumentSource = "agent",
): Record<string, unknown> => toJsonSchema(DOCUMENT_SCHEMAS[target][source]);

/** Every target's agent-facing schema, in `DOCUMENT_SCHEMA_TARGETS` order. */
export const allDocumentJsonSchemas = (
  source: DocumentSource = "agent",
): ReadonlyMap<DocumentSchemaTarget, Record<string, unknown>> =>
  new Map(
    DOCUMENT_SCHEMA_TARGETS.map((target) => [target, documentJsonSchema(target, source)] as const),
  );

/**
 * The committed snapshot directory, relative to the package root.
 *
 * The generated schemas are checked in as files and Git is their version
 * history — the plan deliberately has no `schema_definition` table, because a
 * table would need its own write path, its own migration story and its own
 * consistency check against the code, to answer a question `git log` already
 * answers. Schema generation writes these files deterministically, so an
 * unreviewed schema change shows up as a diff in a pull request.
 */
export const SCHEMA_SNAPSHOT_DIR = "schema";

/** The snapshot filename for a target, e.g. `pm.stream.feature.v1.input.json`. */
export const schemaSnapshotFile = (target: DocumentSchemaTarget, source: DocumentSource): string =>
  `${target}.${source}.json`;
