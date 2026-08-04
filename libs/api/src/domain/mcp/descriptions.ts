import {
  COMPACT_FIRST,
  CONFIRM_RULE,
  HIERARCHY,
  PROJECTED_CONTEXT,
  SCHEMA_ON_DEMAND,
  STREAM_TYPES_LINE,
  UNKNOWN_RULE,
  VALIDATE_FIRST,
} from "./fragments";

/**
 * Tier 2 of three (domain spec §10.5): what each tool needs the model to know at
 * the moment it decides to call it.
 *
 * Budget: **80 to 1200 characters each**, and the whole `tools/list` payload
 * **≤ 12 KB**, enforced by `test/domain/mcp/text.test.ts`. The lower bound is
 * there because a one-line description is how a tool gets called wrongly; the
 * upper bound is there because six long descriptions are paid for on every
 * `tools/list`. A description that will not fit belongs in a `zpecs://guide/`
 * resource with a pointer from here.
 *
 * Composed from `fragments.ts` rather than written out, so a rule that changes is
 * edited once. Keyed by tool name so `descriptions.ts` and the registry cannot
 * silently disagree about which tools exist.
 */
export const TOOL_DESCRIPTIONS = {
  search_context: [
    "Search the epics, streams and tasks of this workspace by full text and by fuzzy title " +
      "match. Start here.",
    COMPACT_FIRST,
    "Search before you create: an existing stream under the right epic is almost always the " +
      "right home for a new requirement, and a duplicate stream is the most expensive mistake " +
      "available in this system.",
    HIERARCHY,
  ].join(" "),

  get_context: [
    "Load one epic, stream or task by key, together with the context needed to act on it: the " +
      "parent stream's purpose, the referenced requirements, the linked acceptance criteria, " +
      "the business rules and edge cases that apply, and the dependencies.",
    PROJECTED_CONTEXT,
    "For a request like 'implement TASK-123', call this on the task — the stream context " +
      "arrives with it, so no second call is needed to learn what the task is for.",
  ].join(" "),

  get_entity_schema: [
    "Return the exact JSON Schema a document must satisfy, for one entity kind (epic, stream " +
      "or task) and, for a stream, its stream_type — each stream type has its own content " +
      "schema, so the type is required there.",
    SCHEMA_ON_DEMAND,
    "Cross-field rules that JSON Schema cannot express are stated in the field descriptions " +
      "and enforced by validate_change_set, so a document that satisfies this schema can still " +
      "be rejected for a reason the schema could not carry.",
    STREAM_TYPES_LINE,
  ].join(" "),

  validate_change_set: [
    "Dry-run a change set: schema validation, relationship and cycle checks, and the business " +
      "rules, on the identical code path apply_change_set uses. Nothing is written and no " +
      "confirmation is needed.",
    VALIDATE_FIRST,
    "Fix what it reports by correcting the change set, never by working around the rule. If a " +
      "report reveals the user's intent was ambiguous, ask them rather than choosing for them.",
    UNKNOWN_RULE,
  ].join(" "),

  apply_change_set: [
    "Apply a change set atomically: create and update epics, streams and tasks, and link them " +
      "to each other. Either every operation lands or none does. Returns the ids, keys and new " +
      "revisions of everything it touched.",
    CONFIRM_RULE,
    VALIDATE_FIRST,
    "Each update carries the revision it was based on; a stale revision is rejected rather " +
      "than overwritten, so re-read with get_context and rebuild the change set instead of " +
      "retrying it unchanged.",
    "Business content belongs on epics and streams, technical content on tasks — read " +
      "zpecs://guide/separation for both lists in full.",
  ].join(" "),

  get_next_work: [
    "List the open, unblocked tasks of a stream or epic in priority order — the answer to " +
      "'what should I work on next'.",
    "A task appears only when its own status is workable and nothing it is blocked_by is still " +
      "open, so the list is safe to start at the top of.",
    "If it comes back empty, report that and ask what should happen next. Do not invent tasks " +
      "to fill it: an empty list usually means the stream needs planning, which is a decision " +
      "for the user.",
    UNKNOWN_RULE,
  ].join(" "),
} as const;

export type ToolName = keyof typeof TOOL_DESCRIPTIONS;
