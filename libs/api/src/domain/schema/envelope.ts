import { z } from "zod";
import {
  epicStatusSchema,
  milestoneStatusSchema,
  ruleStatusSchema,
  streamStatusSchema,
  streamTypeSchema,
  taskStatusSchema,
  taskTypeSchema,
  type VersionedEntityType,
} from "../enums";
import {
  entityId,
  entityKey,
  entityPrioritySchema,
  milestoneKey,
  sourceId,
  sourceTypeSchema,
  statement,
  streamSizeSchema,
  title,
} from "./primitives";

/**
 * The shared document envelope from the domain spec §5: `entity`,
 * `schema_version`, `meta`, `content`, `links`, `provenance`. Every Epic,
 * Stream, Task, Rule and Milestone document has these keys; Task additionally
 * carries `execution`, and `content` differs by entity type.
 *
 * ## Why `z.strictObject` and not `z.object`, everywhere
 *
 * Measured on Zod 4.4.3: `z.toJSONSchema(schema, { io: "input" })` **strips**
 * `additionalProperties: false` from a plain `z.object()`, but keeps it on a
 * `z.strictObject()`. The MCP tool input schemas are generated with
 * `io: "input"`, and that `additionalProperties: false` is the entire mechanism
 * behind the domain spec §14 rule "no invented fields". A single `z.object()`
 * anywhere in this tree therefore silently deletes the rule from what the model
 * sees, with no type error. There is no case in this layer where a plain
 * `z.object()` is correct.
 *
 * ## Why `meta` is split in two
 *
 * `meta` exists in two versions, and the split is a security mechanism rather
 * than a convention:
 *
 * - `…Meta.input` — what an agent is allowed to write: `title`, `status`,
 *   `priority`, plus the entity's own type discriminator.
 * - `…Meta.stored` — that, plus the document identity fields the server assigns:
 *   `id`, `key` and `revision`.
 *
 * Project and workspace ownership deliberately live only on the relational row.
 * Duplicating them in document JSON would make a hierarchy move either mutate
 * descendants without a revision or leave two authorities that disagree.
 *
 * Because the input version is a `strictObject`, an agent that sends
 * `meta.revision: 9` gets an `unrecognized_keys` issue instead of a silent
 * optimistic-concurrency bypass. Revisions and keys are not forgeable.
 */

/* ------------------------------------------------------------------- links */

/**
 * Graph relationships are writable only through change-set `link`/`unlink`
 * operations. `entity_link` is the sole source used by cycle checks, context and
 * next-work queries; accepting the same relation in current document JSON would
 * create two stores that can disagree. Historical v1 snapshots remain raw audit
 * JSON and never pass through these v2 schemas.
 */
export const epicLinks = {
  input: z.strictObject({}),
  stored: z.strictObject({}),
} as const;

export const streamLinks = {
  input: z.strictObject({ parent_epic_id: entityId }),
  stored: z.strictObject({ parent_epic_id: entityId }),
} as const;

export const taskLinks = {
  input: z.strictObject({ parent_stream_id: entityId }),
  stored: z.strictObject({ parent_stream_id: entityId }),
} as const;

/** Rule relations live only in `entity_link`; Milestones are never graph endpoints. */
export const ruleLinks = {
  input: z.strictObject({}),
  stored: z.strictObject({}),
} as const;

export const milestoneLinks = {
  input: z.strictObject({}),
  stored: z.strictObject({}),
} as const;

/* -------------------------------------------------------------- provenance */

/** One immutable observation that claim-level evidence can cite by local id. */
export const provenanceSource = z.strictObject({
  id: sourceId,
  type: sourceTypeSchema,
  reference: statement,
  /** Commit, document version, entity revision or another immutable source marker. */
  snapshot: statement.optional(),
  observed_at: z.iso.datetime({ offset: true }).optional(),
  /** Newer local observations this Source is known to replace. */
  supersedes_source_ids: z.array(sourceId).min(1).optional(),
});

/**
 * Origin, derivation and uncertainty (domain spec §5.6), identical for all three
 * entity types.
 *
 * A factory rather than a shared constant so that every document schema owns its
 * own instance: `z.toJSONSchema()` hoists a schema node that appears twice in
 * one conversion into `$defs` and references it, and a self-contained generated
 * schema is easier for a model to follow than one behind a `$ref`.
 *
 * Sources are a document-local catalogue. Claim elements cite them through
 * `evidence.source_ids`; unknowns live once in the addressable content-level
 * `open_questions` and `assumptions` sections.
 */
export const provenance = () =>
  z
    .strictObject({
      sources: z.array(provenanceSource).optional(),
    })
    .meta({
      description:
        "Immutable local Sources cited by claim evidence. Put uncertainty in addressable content assumptions or open_questions, never in inferred document paths.",
    });

/* -------------------------------------------------------------------- meta */

/**
 * The fields an agent may write on any entity. `status` and the type
 * discriminator are passed in per entity because their enums differ, but they
 * are input fields in the same sense: an agent chooses them.
 */
const META_INPUT_SHAPE = {
  title,
  priority: entityPrioritySchema.optional(),
} as const;

/**
 * The fields the server owns. Every one of these is rejected on input, and
 * `STORED_ONLY_META_KEYS` is derived from this object so the rejection list
 * cannot fall behind the schema.
 */
const META_STORED_SHAPE = {
  id: entityId,
  key: entityKey,
  revision: z.int().min(1),
} as const;

/**
 * The keys an agent must never be able to write. The change-set engine strips
 * them before validation rather than letting a well-meaning agent trip over them.
 */
export const STORED_ONLY_META_KEYS = [
  ...Object.keys(META_STORED_SHAPE),
  "roadmap_order",
  "milestone_key",
  "roadmap_rank",
] as readonly string[];

const metaPair = <Extra extends z.core.$ZodLooseShape>(extra: Extra) => ({
  input: z.strictObject({ ...META_INPUT_SHAPE, ...extra }),
  stored: z.strictObject({ ...META_STORED_SHAPE, ...META_INPUT_SHAPE, ...extra }),
});

/** Epic `meta`. An epic has no type discriminator: every epic is a business capability. */
export const epicMeta = metaPair({ status: epicStatusSchema });

/**
 * Stream `meta`. `stream_type` lives here, not on `content`, because it selects
 * which content schema applies — see `stream/registry.ts` for why that selection
 * is a map lookup and not a discriminated union.
 */
const STREAM_META_SHAPE = {
  status: streamStatusSchema,
  stream_type: streamTypeSchema,
  size: streamSizeSchema.optional(),
} as const;

export const streamMeta = {
  input: z.strictObject({ ...META_INPUT_SHAPE, ...STREAM_META_SHAPE }),
  stored: z.strictObject({
    ...META_STORED_SHAPE,
    ...META_INPUT_SHAPE,
    ...STREAM_META_SHAPE,
    milestone_key: milestoneKey.nullable().optional(),
    roadmap_rank: z.int().min(0).nullable().optional(),
  }),
} as const;

/** Task `meta`. */
export const taskMeta = metaPair({
  status: taskStatusSchema,
  task_type: taskTypeSchema,
});

/** Rule and Milestone have no subtype discriminator. */
export const ruleMeta = metaPair({ status: ruleStatusSchema });
export const milestoneMeta = {
  input: z.strictObject({ ...META_INPUT_SHAPE, status: milestoneStatusSchema }),
  stored: z.strictObject({
    ...META_STORED_SHAPE,
    ...META_INPUT_SHAPE,
    status: milestoneStatusSchema,
    /** Server-managed advisory position; equal values are valid. */
    roadmap_order: z.int().min(0),
  }),
} as const;

/* ---------------------------------------------------------------- envelope */

/**
 * Assembles the six-key envelope from the domain spec §5 around an entity's
 * `meta`, `content` and `links`.
 *
 * `entity` and `schema_version` are literals so that a document claiming to be a
 * stream cannot be parsed as a task, and so `schema_version` is a fact in the
 * data rather than a hope — the domain spec §5.2 requires a schema change not to
 * invalidate old rows, which is only possible if every row states its version.
 */
export const documentEnvelope = <
  const Entity extends VersionedEntityType,
  const Version extends string,
  Meta extends z.ZodType,
  Content extends z.ZodType,
  Links extends z.ZodType,
>(options: {
  readonly entity: Entity;
  readonly schemaVersion: Version;
  readonly meta: Meta;
  readonly content: Content;
  readonly links: Links;
}) =>
  z.strictObject({
    entity: z.literal(options.entity),
    schema_version: z.literal(options.schemaVersion),
    meta: options.meta,
    content: options.content,
    links: options.links,
    provenance: provenance(),
  });
