import {
  CONFIRM_RULE,
  HIERARCHY,
  STREAM_TYPES_LINE,
  TASK_TYPES_LINE,
  UNKNOWN_RULE,
  WHAT_VS_HOW,
} from "./fragments";

/**
 * Tier 1 of three (domain spec §10.5): the text every session starts with,
 * returned once in the `initialize` result and then resident in the model's
 * context for the whole conversation.
 *
 * Budget: **3000 characters**, enforced by `test/domain/mcp/text.test.ts`. It is
 * a real cost, paid on every turn of every session, which is why the two other
 * tiers exist — per-tool `description` for what a tool needs at call time, and
 * the `zpecs://guide/` resources for the long form. If this text no longer fits,
 * the content belongs in a resource; the budget is not the thing to change.
 *
 * Contents are fixed by the plan: the Epic/Stream/Task glossary (§3), the
 * what/why vs how split with both "belongs in" lists (§4), the stream and task
 * types (§3.2/§3.3), the unknown-marking rule (§14), and the confirm rule.
 */
export const SERVER_INSTRUCTIONS = [
  "zpecs is the project-management system for this workspace. Epics, streams and tasks live " +
    "here as validated, versioned documents; this server is the only way to read or change " +
    "them.",

  HIERARCHY,

  WHAT_VS_HOW,

  "Belongs in an epic or stream: purpose, business problem, scope and exclusions, outcomes, " +
    "functional requirements, non-functional requirements with measurable targets, workflows, " +
    "business rules, edge cases, business dependencies, acceptance or success criteria, open " +
    "questions and assumptions.",

  "Belongs in a task: frameworks and libraries, concrete files and modules, API endpoints, " +
    "database tables and migrations, technical architecture, implementation decisions, test " +
    "files and strategy, deployment steps, branches and environments. Every task references " +
    "the requirements or acceptance criteria it serves, so what and why stay separate from " +
    "how but remain traceable.",

  `${STREAM_TYPES_LINE} Pick the type from the nature of the work; do not force a user-story ` +
    "shape onto a bug, an experiment or an investigation.",

  TASK_TYPES_LINE,

  UNKNOWN_RULE,

  CONFIRM_RULE,

  "Working order: search_context to find what exists, get_context to load it, " +
    "get_entity_schema for the exact document shape, validate_change_set on your proposal, " +
    "apply_change_set once the user approves; put confirm: true on each destructive operation. " +
    "get_next_work answers 'what " +
    "should I do next' for a stream or epic. Prefer extending an existing stream under the " +
    "right epic over creating a duplicate.",
].join("\n\n");
