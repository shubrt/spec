import { CONFIRM_RULE } from "./fragments";

/**
 * Tier 2 of three (domain spec §10.5): what each tool needs the model to know at
 * the moment it decides to call it.
 *
 * Budget: **80 to 1200 characters each**, and the whole `tools/list` payload
 * **≤ 12 KB**. The lower bound is
 * there because a one-line description is how a tool gets called wrongly; the
 * upper bound is there because seven long descriptions are paid for on every
 * `tools/list`. A description that will not fit belongs in a `spec://guide/`
 * resource with a pointer from here.
 *
 * Shared cross-tool policy still comes from `fragments.ts`; tool-specific prose
 * stays compact here. Keyed by tool name so the registry cannot silently drift.
 *
 * **What deliberately is not here:** the hierarchy glossary and the
 * do-not-invent rule. Both are tier 1 — `SERVER_INSTRUCTIONS`, delivered once at
 * `initialize` — and repeating them per tool paid for them seven times on every
 * `tools/list` while risking two subtly different versions of the same rule.
 * Measured: with them, the payload was 14497 bytes against a 12288 budget; the
 * two change-set tools alone carry 2456 bytes of schema each, and that schema is
 * where the rules JSON Schema *can* express already live.
 */
export const TOOL_DESCRIPTIONS = {
  list_context: [
    "List projects or compact E/S/T/M/R rows without document JSON.",
    "Use project for a tree, parent for children, milestone for assigned Streams and Tasks, and cursor with unchanged filters; open a key with get_context.",
  ].join(" "),

  search_context: [
    "Search versioned entities by full text or fuzzy title and return compact hits.",
    "Search before creating a Stream or Rule to avoid duplicates; open a hit with get_context.",
  ].join(" "),

  get_context: [
    "Load one E/S/T/M/R document and projected context by key.",
    "Tasks include relevant Stream claims and effective Rules; Milestones include assigned Streams. Reuse project and revision on writes.",
  ].join(" "),

  get_entity_schema: [
    "Return the exact agent-document JSON Schema for an Epic, Task, Rule, Milestone, or Stream type.",
    "In change-set data omit entity, schema_version and links; create derives them, update accepts section patches, and validate_change_set enforces cross-field rules.",
  ].join(" "),

  validate_change_set: [
    "Rollback-only dry run of apply's schema, references, readiness, cycles and revisions; nothing is written, and destructive operations may be simulated unconfirmed.",
    "Fix every reported issue; ask when intent is ambiguous.",
  ].join(" "),

  apply_change_set: [
    "Atomically apply create, update, link, unlink, archive, delete, move, or schedule and return keys and revisions.",
    CONFIRM_RULE,
    "A stale expected_revision is rejected: use the returned current document to rebuild.",
  ].join(" "),

  get_next_work: [
    "Find executable Tasks and Stream-planning work in a Project, Milestone, Epic, or Stream after parent and blocker checks.",
    "Omit key for a named Project. human/agent includes matching and either Tasks; unknown executors and untyped planning are excluded and counted.",
  ].join(" "),
} as const;

export type ToolName = keyof typeof TOOL_DESCRIPTIONS;
