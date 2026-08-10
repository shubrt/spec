import { z } from "zod";
import { RELATIONSHIP_TYPE, VERSIONED_ENTITY_TYPE } from "../enums";

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
 *
 * ## Why the operation is one flat object and not a discriminated union
 *
 * A `z.discriminatedUnion` over eight operations generates eight JSON Schema
 * branches, each repeating the fields it shares with the others, and this schema
 * is serialised into `tools/list` twice — once for `validate_change_set`, once for
 * `apply_change_set`. A flat object with an `operation` enum and per-operation
 * optional fields is a fraction of the size, which is what keeps the derived
 * schema inside its 3 KB budget. The price is that "an `update` needs an
 * `expected_revision`" cannot be expressed structurally: `.refine()` is silently
 * dropped by `z.toJSONSchema()`, so a structural rule that a model never sees is
 * worse than no structural rule at all. Those constraints live in
 * `changeSet/plan.ts`, which reports them as issues an agent can act on, and in
 * the compact operation summary plus `zpecs://guide/change-sets`. Per-field prose
 * is deliberately absent because this schema is paid for twice in `tools/list`.
 *
 * ## Why `confirm` is per operation and not per call
 *
 * `apply_change_set` is annotated `destructiveHint`, and an annotation cannot tell
 * whether a *particular* change set destroys anything. A gate at the tool boundary
 * would therefore demand `confirm: true` on every apply, including a change set
 * that only creates — which trains an agent to send the flag reflexively and
 * destroys the signal the gate exists to carry. The flag belongs on the operation
 * that is actually destructive. Archive/delete/move always need it; updates need
 * it when they remove id-bearing content or change a Rule with active consumers.
 * `service/changeSet.ts` decides from the simulated canonical result. A change set
 * is atomic, so a partly confirmed set is never half applied.
 *
 * `mcp/defineTool.ts` used to derive a per-call gate from `destructiveHint`; that
 * coupling was removed so this one is the only one, and `destructiveHint` is now
 * purely the client-approval annotation the MCP spec means it to be.
 *
 * ## Why an operation can name a project
 *
 * A key is unique per project, so a bare key is resolved by asking every project in
 * the workspace, and two answers is a refusal rather than a guess. `project` is how
 * a caller qualifies an existing target (or a create's parent). A cross-project
 * move may need a second qualifier, `parent_project`, because target and new parent
 * can deliberately live in different projects.
 */

/** The eight operations. Order is the order they are listed to the model. */
export const CHANGE_SET_OPERATION = [
  "create",
  "update",
  "link",
  "unlink",
  "archive",
  "delete",
  "move",
  "schedule",
] as const;
export type ChangeSetOperationKind = (typeof CHANGE_SET_OPERATION)[number];

/**
 * A temp id: `$stream_new`. The `$` is load-bearing rather than decorative.
 *
 * Within one change set an agent has to be able to say "the stream I am creating
 * three operations up", and it cannot use a key because the server has not issued
 * one yet. Without a sigil that reference is a bare string in the same field a
 * real key goes in, so `S-1` (a typo for `S-12`) and `stream_new` (a temp id)
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
  entity: z.enum(VERSIONED_ENTITY_TYPE).optional(),
  key: z.string().min(1).max(128).optional(),
  parent: z.string().min(1).max(128).optional(),
  // Keys are unique per project. Terse because this is paid for twice in
  // tools/list; an ambiguity refusal names the projects and the right qualifier.
  project: z.string().min(1).max(200).optional(),
  parent_project: z.string().min(1).max(200).optional(),
  expected_revision: z.int().min(1).optional(),
  rebase_stream_revision: z.literal(true).optional(),
  data: z.record(z.string(), z.unknown()).optional(),
  items: z
    .array(
      z.strictObject({
        action: z.enum(["add", "replace", "remove"]),
        path: z.string().min(1).max(200),
        id: z.string().min(1).max(128),
        value: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .min(1)
    .max(50)
    .optional(),
  // Optional rather than `z.literal(true)`: a required `true` would appear in the
  // generated JSON Schema as a value the model must supply, so it would supply it
  // mechanically on the first attempt and the user would never be asked. Optional
  // in the schema plus a refusal in the pipeline is what forces the round trip
  // through a human.
  confirm: z.boolean().optional(),
  source: z.string().min(1).max(128).optional(),
  target: z.string().min(1).max(128).optional(),
  relationship: z.enum(LINK_INPUT_RELATIONSHIP).optional(),
  milestone: z.string().min(1).max(128).nullable().optional(),
  roadmap_rank: z.int().min(0).nullable().optional(),
  roadmap_order: z.int().min(0).optional(),
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
  create: ["entity", "key", "parent", "project", "data", "roadmap_order"],
  update: [
    "key",
    "project",
    "expected_revision",
    "rebase_stream_revision",
    "data",
    "items",
    "confirm",
  ],
  link: ["source", "target", "project", "relationship"],
  unlink: ["source", "target", "project", "relationship"],
  archive: ["key", "project", "expected_revision", "confirm"],
  delete: ["key", "project", "expected_revision", "confirm"],
  move: ["key", "project", "expected_revision", "parent", "parent_project", "confirm"],
  schedule: ["key", "project", "expected_revision", "milestone", "roadmap_rank", "roadmap_order"],
} as const satisfies Record<ChangeSetOperationKind, readonly OperationField[]>;

/** Every field an operation can carry, `operation` itself excluded. */
export type OperationField = Exclude<keyof z.output<typeof changeSetOperation>, "operation">;

export const changeSetSchema = z.strictObject({
  reason: z.string().min(1).max(500),
  operations: z
    .array(changeSetOperation)
    .min(1)
    .max(50)
    // One compact map replaces per-field prose: this text is serialised twice,
    // once per change-set tool. The guide carries the exhaustive constraints.
    .describe(
      "Atomic and ordered. create(entity,parent?,data); update(key,expected_revision,data/items/rebase?); " +
        "link/unlink(source,target,relationship); archive/delete/move(key,expected_revision,confirm); " +
        "schedule(key,expected_revision,milestone/roadmap fields). Full rules: zpecs://guide/change-sets.",
    ),
});

export type ChangeSet = z.output<typeof changeSetSchema>;
export type ChangeSetOperation = ChangeSet["operations"][number];
export type ChangeSetItemMutation = NonNullable<ChangeSetOperation["items"]>[number];
