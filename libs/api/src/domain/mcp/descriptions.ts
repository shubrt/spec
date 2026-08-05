import {
  COMPACT_FIRST,
  CONFIRM_RULE,
  PROJECTED_CONTEXT,
  SCHEMA_ON_DEMAND,
  STREAM_TYPES_LINE,
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
 *
 * **What deliberately is not here:** the hierarchy glossary and the
 * do-not-invent rule. Both are tier 1 — `SERVER_INSTRUCTIONS`, delivered once at
 * `initialize` — and repeating them per tool paid for them six times on every
 * `tools/list` while risking two subtly different versions of the same rule.
 * Measured: with them, the payload was 14497 bytes against a 12288 budget; the
 * two change-set tools alone carry 2456 bytes of schema each, and that schema is
 * where the rules JSON Schema *can* express already live.
 */
export const TOOL_DESCRIPTIONS = {
  search_context: [
    "Full-text and fuzzy-title search over this workspace's epics, streams and tasks. Start here.",
    COMPACT_FIRST,
    "Search before you create: an existing stream under the right epic is almost always the " +
      "right home for a new requirement, and a duplicate stream is the costliest mistake here.",
  ].join(" "),

  get_context: [
    "One epic, stream or task by key, with what is needed to act on it: the parent stream's " +
      "purpose, referenced requirements, linked acceptance criteria, applicable business rules " +
      "and edge cases, dependencies.",
    PROJECTED_CONTEXT,
    "For 'implement TASK-123', call this on the task — the stream context comes with it.",
  ].join(" "),

  get_entity_schema: [
    "The exact JSON Schema a document must satisfy, per entity kind (epic, stream, task) and, " +
      "for a stream, its stream_type — each type has its own content schema.",
    SCHEMA_ON_DEMAND,
    "Satisfying this schema is not sufficient: the cross-field rules live in the field " +
      "descriptions and validate_change_set enforces them.",
    STREAM_TYPES_LINE,
  ].join(" "),

  validate_change_set: [
    "Dry-run a change set on the identical path apply_change_set uses: schema, relationships, " +
      "cycles, business rules. Nothing is written.",
    VALIDATE_FIRST,
    "Fix what it reports by correcting the change set, never by working around the rule. If a " +
      "report shows the user's intent was ambiguous, ask them rather than choosing.",
  ].join(" "),

  apply_change_set: [
    "Apply a change set atomically — create, update, link, archive, delete, move. All operations " +
      "land or none do. Returns ids, keys, new revisions.",
    CONFIRM_RULE,
    "A stale expected_revision is rejected, never overwritten: re-read with get_context and " +
      "rebuild instead of retrying.",
  ].join(" "),

  get_next_work: [
    "The open, unblocked tasks of a stream or epic in priority order — what to work on next.",
    "A task appears only when its own status is workable and nothing it is blocked_by is still " +
      "open, so the list is safe to start at the top of.",
    "If it comes back empty, say so and ask what should happen next. Never invent tasks to fill " +
      "it: an empty list usually means the stream needs planning, which is the user's decision.",
  ].join(" "),
} as const;

export type ToolName = keyof typeof TOOL_DESCRIPTIONS;
