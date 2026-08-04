import { z } from "zod";
import {
  entityTypeSchema,
  epicStatusSchema,
  relationshipTypeSchema,
  streamStatusSchema,
  streamTypeSchema,
  taskStatusSchema,
  taskTypeSchema,
  type EntityType,
} from "../enums";
import {
  actorRef,
  entityId,
  entityKey,
  entityPrioritySchema,
  sourceConfidenceSchema,
  sourceTypeSchema,
  statement,
  title,
} from "./primitives";
import { ruleText } from "./rules";

/**
 * The shared document envelope from the domain spec §5: `entity`,
 * `schema_version`, `meta`, `content`, `links`, `provenance`. Every epic, stream
 * and task document has exactly these keys, and `content` is the only part that
 * differs by entity type.
 *
 * ## Why `z.strictObject` and not `z.object`, everywhere
 *
 * Measured on Zod 4.4.3: `z.toJSONSchema(schema, { io: "input" })` **strips**
 * `additionalProperties: false` from a plain `z.object()`, but keeps it on a
 * `z.strictObject()`. The MCP tool input schemas are generated with
 * `io: "input"`, and that `additionalProperties: false` is the entire mechanism
 * behind the domain spec §14 rule "no invented fields". A single `z.object()`
 * anywhere in this tree therefore silently deletes the rule from what the model
 * sees, with no test failing and no type error. There is no case in this layer
 * where a plain `z.object()` is correct.
 *
 * ## Why `meta` is split in two
 *
 * `meta` exists in two versions, and the split is a security mechanism rather
 * than a convention:
 *
 * - `…Meta.input` — what an agent is allowed to write: `title`, `status`,
 *   `priority`, plus the entity's own type discriminator.
 * - `…Meta.stored` — that, plus everything the server assigns: `id`, `key`,
 *   `project_id`, `workspace_id`, `revision`, the timestamps and
 *   `created_by` / `updated_by`.
 *
 * Because the input version is a `strictObject`, an agent that sends
 * `meta.revision: 9` gets an `unrecognized_keys` issue instead of a silent
 * optimistic-concurrency bypass. Revisions and keys are not forgeable, and
 * `test/domain/schema/envelope.test.ts` proves it field by field rather than
 * trusting the comment.
 */

/* ------------------------------------------------------------------- links */

/**
 * One end of a relationship (domain spec §5.5). Relationships are stored as
 * `(target_type, target_id)` pairs, never as free prose, so that cycle
 * detection and impact analysis can walk them.
 */
export const entityRef = z.strictObject({
  target_type: entityTypeSchema,
  target_id: entityId,
  reason: statement.optional(),
});

/**
 * A dependency, which additionally names *which* relationship holds. The
 * relationship set lives in `domain/enums.ts` because `entity_link.relationship`
 * is a column.
 */
export const dependencyRef = entityRef.extend({
  relationship: relationshipTypeSchema,
});

/**
 * Epic links. An epic has no `parent_*` link: its parent is the project, which
 * is a relational column and not a document relationship (the controller ruling
 * that `project` is a container, not a versioned entity).
 */
export const epicLinks = z.strictObject({
  related_epics: z.array(entityRef).optional(),
  supersedes: z.array(entityRef).optional(),
  extends: z.array(entityRef).optional(),
});

/** Stream links, exactly the keys the canonical §6 example uses. */
export const streamLinks = z.strictObject({
  parent_epic_id: entityId,
  depends_on: z.array(dependencyRef).optional(),
  related_streams: z.array(entityRef).optional(),
  supersedes: z.array(entityRef).optional(),
  extends: z.array(entityRef).optional(),
});

/**
 * Task links, exactly the keys the canonical §7 example uses.
 *
 * `blocks` appears here even though `domain/enums.ts` deliberately omits it from
 * `RELATIONSHIP_TYPE`: the document is what an agent writes, and "A blocks B" is
 * the natural way to say it, while the `entity_link` table stores only
 * `blocked_by` so that a cycle check never has to reconcile two directions. The
 * change-set engine owns that normalisation.
 */
export const taskLinks = z.strictObject({
  parent_stream_id: entityId,
  blocks: z.array(entityRef).optional(),
  blocked_by: z.array(entityRef).optional(),
  related_tasks: z.array(entityRef).optional(),
});

/* -------------------------------------------------------------- provenance */

/** Where one statement in the document came from (domain spec §5.6). */
export const provenanceSource = z.strictObject({
  type: sourceTypeSchema,
  reference: statement.optional(),
  confidence: sourceConfidenceSchema,
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
 * The domain spec §11 rule "mark what is unknown" is carried here as a
 * `description` and nowhere else, because it cannot be checked from a single
 * document — nothing in the JSON distinguishes an honest statement from an
 * invented one. Descriptions are the enforcement, which is why `rules.ts` files
 * it under `enforcement: "description"` rather than pretending it is validated.
 */
export const provenance = () =>
  z
    .strictObject({
      sources: z.array(provenanceSource).optional(),
      /** Dotted document paths that were inferred rather than stated, e.g. `content.requirements.non_functional`. */
      inferred_fields: z.array(statement).optional(),
      open_questions: z.array(statement).optional(),
      assumptions: z.array(statement).optional(),
      /** Ids of the entities this document was derived from. */
      created_from: z.array(entityId).optional(),
      created_by: actorRef.optional(),
    })
    .meta({ description: ruleText("unknowns_must_be_marked") });

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
 * `STORED_ONLY_META_KEYS` is derived from this object so the test cannot fall
 * behind the schema.
 */
const META_STORED_SHAPE = {
  id: entityId,
  key: entityKey,
  project_id: entityId,
  /**
   * Optional because the canonical §5.3, §6 and §7 documents do not carry it:
   * the workspace is a relational column and an authorisation fact, and a
   * document read back from the database is valid with or without it.
   */
  workspace_id: entityId.optional(),
  revision: z.int().min(1),
  created_at: z.iso.datetime({ offset: true }).optional(),
  updated_at: z.iso.datetime({ offset: true }).optional(),
  created_by: actorRef.optional(),
  updated_by: actorRef.optional(),
} as const;

/**
 * The keys an agent must never be able to write. Exported for the test that
 * proves each one is rejected, and for the change-set engine, which strips them
 * before validation rather than letting a well-meaning agent trip over them.
 */
export const STORED_ONLY_META_KEYS = Object.keys(META_STORED_SHAPE) as readonly string[];

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
export const streamMeta = metaPair({
  status: streamStatusSchema,
  stream_type: streamTypeSchema,
});

/** Task `meta`. */
export const taskMeta = metaPair({
  status: taskStatusSchema,
  task_type: taskTypeSchema,
});

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
  const Entity extends EntityType,
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
