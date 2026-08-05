/**
 * Every server-side rule from the domain spec §11, plus the two mechanisms §14
 * and §12 depend on, in one table with an explicit enforcement site.
 *
 * Why a table and not scattered `throw new Error("...")` strings: the same
 * `RuleId` has to appear in three places — the runtime issue an agent gets back
 * from `validate_change_set`, the MCP tool description the model reads before it
 * writes, and this table. Sourcing all three from here is what stops them
 * drifting. Nothing in this file imports a Zod schema, so `rules.ts` is the
 * bottom of the dependency order and the schemas can quote it freely.
 *
 * The domain spec §11 rules deliberately do *not* all land in Zod. Zod validates
 * one document in isolation; half of §11 is about relationships between rows,
 * about the tenant, or about the audit trail. `enforcement` records where each
 * rule actually lives so that "this is validated" is never assumed:
 *
 * - `zod` — the structure of the schema itself makes the violation
 *   unrepresentable (`strictObject`, a required field, a closed enum).
 * - `readiness` — a cross-field check in `readiness.ts`, run by
 *   `parseDocument` after the shape parses. Invisible in JSON Schema, because
 *   `z.toJSONSchema()` silently drops `.refine()`.
 * - `description` — the rule cannot be checked from the document at all; it is
 *   an instruction, and its only enforcement is the `.meta({ description })`
 *   text the model sees plus the tool prose.
 * - `db` — a constraint, a foreign key or a trigger in the Drizzle schema.
 * - `service` — a check in a later service or repository layer (workspace
 *   scope, cycle detection, cross-document id resolution, confirmation gates).
 */

/** Where a rule is actually enforced. See the file header for what each means. */
export const RULE_ENFORCEMENT = ["zod", "readiness", "description", "db", "service"] as const;
export type RuleEnforcement = (typeof RULE_ENFORCEMENT)[number];

type Rule = {
  /** The section of `docs/pm-mcp-datenmodell-kontext.md` the rule comes from. */
  readonly spec: string;
  readonly enforcement: RuleEnforcement;
  /**
   * The remediation text. Written as an instruction to the agent, present tense,
   * no leading rule id — `ruleText()` prefixes that so the id can never be
   * spelled differently in the message than in the key.
   */
  readonly message: string;
};

/**
 * Snake-case semantic ids rather than opaque numbers: the id travels to the
 * model inside an error message and inside a tool description, and
 * `ready_task_needs_definition_of_done` is self-explaining there in a way that
 * `ZPECS-R07` is not.
 */
export const RULES = {
  /* ---------------------------------------------------------------- zod */

  no_invented_fields: {
    spec: "§14",
    enforcement: "zod",
    message:
      "Only fields defined by the entity schema are accepted. Call get_entity_schema for the exact shape instead of inventing a field, and put anything the schema has no place for into content.open_questions.",
  },

  server_owned_meta_is_not_writable: {
    spec: "§5.3, §12",
    enforcement: "zod",
    message:
      "meta.id, meta.key, meta.project_id, meta.workspace_id, meta.revision, the timestamps and meta.created_by/updated_by are assigned by the server and must not be sent. Pass the current revision as expected_revision on the change set instead of writing meta.revision.",
  },

  /* ----------------------------------------------------------- readiness */

  ready_stream_needs_success_criterion: {
    spec: "§11",
    enforcement: "readiness",
    message:
      "A stream at status ready or beyond needs at least one business success criterion. Provide content.acceptance_criteria, or for an experiment content.success_criteria, or keep the stream at draft or planned.",
  },

  ready_task_needs_definition_of_done: {
    spec: "§11",
    enforcement: "readiness",
    message:
      "A task at status ready or beyond needs a technical definition of done: at least one entry in content.done_when and at least one in content.verification.",
  },

  /**
   * The domain spec §11 wording names the experiment ("Ein Experiment darf
   * Success Criteria statt klassischer Acceptance Criteria verwenden"), but the
   * rule is about the criterion, not the type: the `experiment` schema arrives in
   * a later increment while `investigation` already carries `success_criteria`.
   * Naming the id after the mechanism keeps it true for both, so the id does not
   * have to be renamed when `experiment` lands.
   */
  success_criteria_may_replace_acceptance_criteria: {
    spec: "§11",
    enforcement: "readiness",
    message:
      "An investigation or experiment stream may satisfy its success criterion with content.success_criteria or content.expected_decision instead of classic acceptance criteria, but it needs one of them to reach ready.",
  },

  ready_bug_needs_actual_and_expected_behavior: {
    spec: "§11",
    enforcement: "readiness",
    message:
      "A bug stream at status ready or beyond needs both content.actual_behavior and content.expected_behavior. While either is still unknown, keep the stream at draft and record the gap in content.open_questions.",
  },

  task_references_business_requirements: {
    spec: "§11, §14",
    enforcement: "readiness",
    message:
      "A task at status ready or beyond must reference the business work it implements: content.implements.stream_id plus at least one requirement id or acceptance criterion id.",
  },

  /* --------------------------------------------------------- description */

  unknowns_must_be_marked: {
    spec: "§11, §14",
    enforcement: "description",
    message:
      "Never write a guess as if the user had stated it. Anything unknown goes into content.open_questions, content.assumptions or provenance.inferred_fields, and provenance.sources records how firmly each source supports what was written.",
  },

  /* ------------------------------------------------------------------ db */

  stream_belongs_to_one_epic: {
    spec: "§11",
    enforcement: "db",
    message:
      "A stream belongs to exactly one existing epic. links.parent_epic_id must name an epic in the same project.",
  },

  task_belongs_to_one_stream: {
    spec: "§11",
    enforcement: "db",
    message:
      "A task belongs to exactly one existing stream. links.parent_stream_id must name a stream in the same project.",
  },

  every_change_is_recorded: {
    spec: "§11, §12",
    enforcement: "db",
    message:
      "Every versioned document create, update, archive or move appends an entity_revision snapshot with author and revision; hard delete preserves prior snapshots. Link/unlink audit is not part of this MVP.",
  },

  /* ------------------------------------------------------------- service */

  every_operation_carries_workspace_scope: {
    spec: "§11",
    enforcement: "service",
    message:
      "Every read and every write is scoped by workspace and project. Tool inputs never carry a tenant id; the workspace comes from the authenticated token.",
  },

  reads_and_writes_stay_inside_the_workspace: {
    spec: "§11",
    enforcement: "service",
    message:
      "An entity outside the caller's workspace is not readable and not writable, and is reported as not found rather than as forbidden.",
  },

  referenced_ids_must_exist: {
    spec: "§11",
    enforcement: "service",
    message:
      "Requirement ids and acceptance criterion ids referenced from a task must exist in the parent stream document.",
  },

  dependencies_must_be_acyclic: {
    spec: "§11",
    enforcement: "service",
    message: "Dependencies must not form a cycle, directly or through other entities.",
  },

  destructive_operations_need_confirmation: {
    spec: "§11",
    enforcement: "service",
    message:
      "Deleting, archiving or moving an entity requires confirm: true on that operation. Without it the whole change set is refused and nothing is written.",
  },
} as const satisfies Record<string, Rule>;

export type RuleId = keyof typeof RULES;

/** Stable order for tests, tool descriptions and documentation. */
export const RULE_IDS = Object.keys(RULES) as readonly RuleId[];

/**
 * The single formatting of a rule for human and model consumption. Every
 * runtime issue and every generated description goes through this, so the id is
 * always spelled the same and is always greppable back to this table.
 */
export const ruleText = (id: RuleId): string => `[${id}] ${RULES[id].message}`;

/** The rules enforced at a given site, in table order. */
export const rulesEnforcedBy = (enforcement: RuleEnforcement): readonly RuleId[] =>
  RULE_IDS.filter((id) => RULES[id].enforcement === enforcement);

/**
 * The rules `parseDocument` can actually report. Anything else in the table is
 * enforced elsewhere, and a test pins this set against what the parser emits so
 * a rule can never claim schema enforcement it does not have.
 */
export const PARSE_ENFORCED_RULE_IDS: readonly RuleId[] = [
  ...rulesEnforcedBy("zod"),
  ...rulesEnforcedBy("readiness"),
];

/**
 * One thing wrong with a document.
 *
 * `rule` is `null` for a plain shape failure — "expected string, received
 * number" is not a domain rule, and labelling it with one would make the rule
 * table meaningless. Only violations that map to a real entry above carry an id,
 * which is what lets the tool description and the error message be checked
 * against each other.
 */
export type DocumentIssue = {
  readonly rule: RuleId | null;
  /** Dotted path to the offending field, `""` for the document itself. */
  readonly path: string;
  readonly message: string;
};

/** An issue whose message is owned by the rule table. The only way to build one. */
export const ruleIssue = (rule: RuleId, path: string): DocumentIssue => ({
  rule,
  path,
  message: ruleText(rule),
});

/** A shape failure with no domain rule behind it — the message comes from Zod. */
export const shapeIssue = (path: string, message: string): DocumentIssue => ({
  rule: null,
  path,
  message,
});
