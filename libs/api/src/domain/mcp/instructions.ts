import {
  CONFIRM_RULE,
  DECISION_RULE,
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
 * Budget: **3000 characters**. It is
 * a real cost, paid on every turn of every session, which is why the two other
 * tiers exist — per-tool `description` for what a tool needs at call time, and
 * the `spec://guide/` resources for the long form. If this text no longer fits,
 * the content belongs in a resource; the budget is not the thing to change.
 *
 * Contents are fixed by the plan: the Epic/Stream/Task glossary (§3), the
 * what/why vs how split with both "belongs in" lists (§4), the stream and task
 * types (§3.2/§3.3), the unknown-marking rule (§14), the decision rule (§13),
 * and the confirm rule. The two "belongs in" lists are the compressed form; the
 * full lists are `spec://guide/separation`, which is what paid for the decision
 * rule's place here.
 */
export const SERVER_INSTRUCTIONS = [
  "spec is the project-management system for this workspace. Epics, Streams, Tasks, Rules, " +
    "and Milestones live here as validated, versioned documents; this server is their only " +
    "write path.",

  HIERARCHY,

  WHAT_VS_HOW,

  "Belongs in an epic or stream: purpose, business problem, scope and exclusions, outcomes, " +
    "functional and measurable non-functional requirements, workflows, Rule applications, edge " +
    "cases, dependencies, acceptance criteria, open questions and assumptions.",

  "Belongs in a task: frameworks, files and modules, endpoints, tables and migrations, " +
    "technical architecture, implementation decisions, test strategy, deployment steps, branches " +
    "and environments. Every ready Task references a typed business target in its parent Stream, " +
    "so what and why stay separate from how but stay traceable.",

  `${STREAM_TYPES_LINE} Pick the type from the nature of the work; do not force a user-story ` +
    "shape onto a bug, an experiment or an investigation.",

  TASK_TYPES_LINE,

  UNKNOWN_RULE,

  DECISION_RULE,

  CONFIRM_RULE,

  "Working order: list_context or search_context to find what exists, get_context to load it, " +
    "get_entity_schema for the exact document shape, validate_change_set on your proposal, " +
    "apply_change_set once the user approves; put confirm: true on each destructive operation. " +
    "get_next_work answers 'what should I do next' for a Project, Milestone, Epic, or Stream. " +
    "Prefer extending an existing Stream or referencing an existing Rule over duplicating it.",
].join("\n\n");
