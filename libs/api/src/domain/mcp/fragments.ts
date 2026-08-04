import { STREAM_TYPE, TASK_TYPE } from "../enums";

/**
 * The sentences that appear in more than one piece of tool text.
 *
 * Every per-tool `description` and the server instructions are composed from
 * these, so a rule that changes is edited once instead of six times. That is not
 * only about effort: six near-identical restatements of the same rule are how a
 * model ends up reading two subtly contradictory versions of it.
 *
 * Each fragment is one or two whole sentences with no trailing space, so callers
 * join them with `" "` and get readable prose either way round. They are counted
 * against the budgets in `test/domain/mcp/text.test.ts`.
 */

/** Domain spec §3. The one paragraph every tool needs in order to be used at all. */
export const HIERARCHY =
  "Hierarchy: Workspace > Project > Epic > Stream > Task. An epic is a long-lived business " +
  "capability, never a sprint or a release. A stream is one bounded change, problem or " +
  "investigation inside an epic and is the planning unit for the business 'what'. A task is " +
  "one technical unit of work under a stream.";

/** Domain spec §4, compressed to the rule plus the two failure modes it prevents. */
export const WHAT_VS_HOW =
  "Epic and stream hold what, why, scope, rules and acceptance criteria; a task holds how it " +
  "is built technically. Keep frameworks, files, endpoints, tables, migrations and test " +
  "strategy out of streams unless they are a binding constraint recorded with a reason, and " +
  "keep business requirements out of tasks — reference them from the task instead.";

/** Domain spec §14: no invented requirements. */
export const UNKNOWN_RULE =
  "Never invent requirements, acceptance criteria or scope. If the user did not say it, omit " +
  "the field or record it as an open question or assumption. An incomplete draft is a correct " +
  "result; a confident guess is a defect that outlives the conversation.";

/** The MVP's only gate on destructive operations (global constraints: no role gating). */
export const CONFIRM_RULE =
  "Writing is gated: pass confirm: true. Show the user exactly what will change, get explicit " +
  "approval, then repeat the identical call with confirm: true.";

/** Why read tools return summaries. */
export const COMPACT_FIRST =
  "Results are compact on purpose — key, title, type, status, snippet — so a search costs a " +
  "fraction of a document. Load full detail with get_context, only for the keys you need.";

/** Domain spec §7: the context bundle is a projection. */
export const PROJECTED_CONTEXT =
  "Related entities are projected, not duplicated: you get the fields needed to act, not a " +
  "second copy of a document that can be loaded in its own right.";

/** Why the dry run exists at all (Zod → JSON Schema drops cross-field rules). */
export const VALIDATE_FIRST =
  "Validate before applying. validate_change_set runs the same schema, relationship and " +
  "cycle checks apply_change_set runs and writes nothing, and it is the only channel that " +
  "reports the cross-field rules a JSON Schema cannot express.";

/** Why guessing a document shape is never necessary. */
export const SCHEMA_ON_DEMAND =
  "Do not write a document from memory of these descriptions: call get_entity_schema for the " +
  "exact current JSON Schema, or read the zpecs://schema/ resources.";

/** Both lists derive from domain/enums.ts, so a new value cannot go unmentioned. */
export const STREAM_TYPES_LINE = `Stream types: ${STREAM_TYPE.join(", ")}.`;
export const TASK_TYPES_LINE = `Task types: ${TASK_TYPE.join(", ")}.`;
