import { CONFIRM_RULE } from "./fragments";

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
 * Shared cross-tool policy still comes from `fragments.ts`; tool-specific prose
 * stays compact here. Keyed by tool name so the registry cannot silently drift.
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
    "Returns compact hits; load a chosen key with get_context.",
    "Search before create so a new requirement does not duplicate an existing stream.",
  ].join(" "),

  get_context: [
    "One epic, stream or task by key, with its document and projected parent context, rules, " +
      "acceptance criteria and dependencies.",
    "For 'implement TASK-123', call this on the task — the stream context comes with it.",
  ].join(" "),

  get_entity_schema: [
    "The exact composed agent-document JSON Schema for an epic, task or concrete stream_type.",
    "For change-set data omit entity, schema_version and links: create derives them from entity " +
      "and parent, while update accepts section patches. Field descriptions carry rules that " +
      "validate_change_set enforces.",
  ].join(" "),

  validate_change_set: [
    "Rollback-only dry run of apply's schema, references, readiness, cycle and OCC path. Nothing " +
      "is written; unconfirmed destructive operations may be simulated safely.",
    "Correct reported issues in the proposal; ask rather than guessing when intent is ambiguous.",
  ].join(" "),

  apply_change_set: [
    "Apply a change set atomically — create, update, link, unlink, archive, delete, move. All " +
      "operations land or none do. Returns ids, keys, new revisions.",
    CONFIRM_RULE,
    "A stale expected_revision is rejected, never overwritten: re-read with get_context and " +
      "rebuild instead of retrying.",
  ].join(" "),

  get_next_work: [
    "Ready or in-progress tasks of a stream or epic, most urgent first.",
    "Hides tasks blocked by an unfinished task; stream or epic dependencies remain in get_context.",
    "If empty, say so and ask what comes next — never invent work.",
  ].join(" "),
} as const;

export type ToolName = keyof typeof TOOL_DESCRIPTIONS;
