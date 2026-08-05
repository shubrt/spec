import { z } from "zod";
import { ENTITY_TYPE, RELATIONSHIP_TYPE } from "../enums";

/**
 * The change set — the single write interface of the whole server (domain spec
 * §12). One reason, a list of operations, applied in order in one transaction.
 *
 * ## What is deliberately not in here: `actor` and `workspace`
 *
 * Neither field exists, and that is a security property rather than an omission.
 * The acting identity and the tenant come from the `AuthContext` that
 * `resolveMcpAuth` built from a verified token, so there is no field for an agent
 * to fill in and therefore nothing to forge: a change set cannot claim to be a
 * different user, and it cannot claim to belong to a different workspace. Because
 * every object here is a `z.strictObject`, sending either one is not ignored, it
 * is rejected with an `unrecognized_keys` issue.
 * `test/domain/changeSet/schema.test.ts` asserts their absence on the schema's own
 * keys, not merely that a well-behaved input parses.
 *
 * ## Why the operation is one flat object and not a discriminated union
 *
 * A `z.discriminatedUnion` over seven operations generates seven JSON Schema
 * branches, each repeating the fields it shares with the others, and this schema
 * is serialised into `tools/list` twice — once for `validate_change_set`, once for
 * `apply_change_set`. A flat object with an `operation` enum and per-operation
 * optional fields is a fraction of the size, which is what keeps the derived
 * schema inside its 3 KB budget. The price is that "an `update` needs an
 * `expected_revision`" cannot be expressed structurally: `.refine()` is silently
 * dropped by `z.toJSONSchema()`, so a structural rule that a model never sees is
 * worse than no structural rule at all. Those constraints live in
 * `changeSet/plan.ts`, which reports them as issues an agent can act on, and in
 * the field descriptions below, which is the only channel the model reads.
 *
 * ## Where `confirm` is
 *
 * Not here. `mcp/defineTool.ts` adds `confirm` to every tool marked
 * `destructiveHint` and refuses the call when it is not `true`, so the flag has
 * exactly one spelling and one enforcement point for the whole server. Declaring a
 * second `confirm` per operation would create a gate that can be satisfied in two
 * places and a change set that is half approved — meaningless for an atomic write.
 */

/** The seven operations. Order is the order they are listed to the model. */
export const CHANGE_SET_OPERATION = [
  "create",
  "update",
  "link",
  "unlink",
  "archive",
  "delete",
  "move",
] as const;
export type ChangeSetOperationKind = (typeof CHANGE_SET_OPERATION)[number];

/**
 * A temp id: `$stream_new`. The `$` is load-bearing rather than decorative.
 *
 * Within one change set an agent has to be able to say "the stream I am creating
 * three operations up", and it cannot use a key because the server has not issued
 * one yet. Without a sigil that reference is a bare string in the same field a
 * real key goes in, so `STR-1` (a typo for `STR-12`) and `stream_new` (a temp id)
 * are indistinguishable — one is a wrong entity, the other is a forward
 * reference, and the pipeline would have to guess. With the sigil the two spaces
 * cannot overlap and a mistyped key fails as a missing key.
 */
export const TEMP_ID_PATTERN = /^\$[a-z][a-z0-9_]{0,39}$/;

/** Whether a reference names something created by this change set. */
export const isTempId = (value: string): boolean => TEMP_ID_PATTERN.test(value);

/**
 * What a caller may name as a relationship. `blocks` is accepted here and stored
 * nowhere: `entity_link` keeps one direction only, so
 * `entityLinkRepository.link` normalises `A blocks B` into `B blocked_by A` by
 * swapping the endpoints. Accepting it is not a convenience — "A blocks B" is how
 * the domain spec §7 task document says it, so refusing the word would make the
 * document vocabulary and the change-set vocabulary disagree.
 */
export const LINK_INPUT_RELATIONSHIP = [...RELATIONSHIP_TYPE, "blocks"] as const;
export type LinkInputRelationship = (typeof LINK_INPUT_RELATIONSHIP)[number];

const changeSetOperation = z.strictObject({
  operation: z.enum(CHANGE_SET_OPERATION),
  entity: z.enum(ENTITY_TYPE).optional().describe("create."),
  key: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe(
      "update, archive, delete, move: the entity's key (EPIC-1, STR-12, TASK-45). " +
        "create: an optional temp id ($new_stream) that later operations here can reference. " +
        "Keys are assigned by the server, so create must not name one.",
    ),
  parent: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe(
      "create, move: the parent's key or temp id — an epic for a stream, a stream for a task. " +
        "An epic's parent is the project.",
    ),
  expected_revision: z
    .int()
    .min(1)
    .optional()
    .describe(
      "update, archive, delete, move: the revision get_context returned. " +
        "A stale value is rejected and nothing is written.",
    ),
  data: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "create, update: document sections (meta, content, links, provenance, execution). " +
        "Each section you send replaces that whole section — arrays are not merged, so send " +
        "the complete list. Shape from get_entity_schema.",
    ),
  source: z.string().min(1).max(128).optional().describe("link, unlink: key or temp id."),
  target: z.string().min(1).max(128).optional().describe("link, unlink: key or temp id."),
  relationship: z.enum(LINK_INPUT_RELATIONSHIP).optional().describe("link, unlink."),
});

/**
 * Which fields belong to which operation. One source for three consumers: the
 * per-field descriptions above, `plan.ts`'s "that field is not used by this
 * operation" check, and the `zpecs://guide/change-sets` documentation.
 *
 * Required-ness is not modelled here. `plan.ts` guards each required field
 * individually because it needs the narrowed type anyway, and a second list of
 * required fields would be a second thing to keep in step.
 */
export const OPERATION_FIELDS = {
  create: ["entity", "key", "parent", "data"],
  update: ["key", "expected_revision", "data"],
  link: ["source", "target", "relationship"],
  unlink: ["source", "target", "relationship"],
  archive: ["key", "expected_revision"],
  delete: ["key", "expected_revision"],
  move: ["key", "expected_revision", "parent"],
} as const satisfies Record<ChangeSetOperationKind, readonly OperationField[]>;

/** Every field an operation can carry, `operation` itself excluded. */
export type OperationField = Exclude<keyof z.output<typeof changeSetOperation>, "operation">;

export const changeSetSchema = z.strictObject({
  reason: z
    .string()
    .min(1)
    .max(500)
    .describe("Why this change set exists, in the user's terms. Recorded on every revision."),
  operations: z
    .array(changeSetOperation)
    .min(1)
    .max(50)
    // Terse on purpose: this text is serialised into `tools/list` twice, once per
    // change-set tool, so every character is paid for twice on every listing.
    .describe("Applied in order, atomically. One intent per set. See zpecs://guide/change-sets."),
});

export type ChangeSet = z.output<typeof changeSetSchema>;
export type ChangeSetOperation = ChangeSet["operations"][number];
