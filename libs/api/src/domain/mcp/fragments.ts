import { STREAM_TYPE, TASK_TYPE } from "../enums";

/**
 * The sentences that appear in more than one piece of tool text.
 *
 * Every per-tool `description` and the server instructions are composed from
 * these, so a rule that changes is edited once instead of seven times. That is not
 * only about effort: seven near-identical restatements of the same rule are how a
 * model ends up reading two subtly contradictory versions of it.
 *
 * Each fragment is one or two whole sentences with no trailing space, so callers
 * join them with `" "` and get readable prose either way round. Keep them within
 * the budgets documented by their callers.
 */

/** Domain spec §3. The one paragraph every tool needs in order to be used at all. */
export const HIERARCHY =
  "Hierarchy: Workspace > Project > Epic > Stream > Task. An epic is a long-lived business " +
  "capability, never a sprint or a release. A stream is one bounded change, problem or " +
  "investigation inside an epic and is the planning unit for the business 'what'. A task is " +
  "one technical unit of work under a stream. Project Rules are canonical constraints and " +
  "Milestones are an advisory roadmap overlay; neither adds an ownership tier.";

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

/**
 * Domain spec §13: the decision itself is the user's, not the agent's. Kept next
 * to `UNKNOWN_RULE` because it is the same failure one step further along — an
 * invented answer rather than an invented requirement.
 */
export const DECISION_RULE =
  "Technical and design decisions are the user's to make. Offer the options and a " +
  "recommendation, get an explicit choice, and only then record it — an unchosen decision " +
  "is an open question.";

/**
 * The MVP's only gate on destructive operations (global constraints: no role
 * gating). **Per operation, not per call:** a flag on the tool would be demanded
 * even by a change set that only creates, and a reflexive confirmation is not
 * consent.
 */
export const CONFIRM_RULE =
  "Archive, delete, move, id-bearing removal, and a Rule update with active consumers need " +
  "confirm: true on that operation. Show the exact removal, movement, or downstream impact, " +
  "get explicit approval, then repeat the identical call with confirm set.";

/** Why read tools return summaries. */
export const COMPACT_FIRST =
  "Hits are compact — key, title, type, status, snippet. Load full detail with get_context, " +
  "only for the keys you need.";

/** Domain spec §7: the context bundle is a projection. */
export const PROJECTED_CONTEXT =
  "Related entities are projected, not duplicated: the fields needed to act, not a second copy " +
  "of a document you could load in its own right.";

/** Why the dry run exists at all (Zod → JSON Schema drops cross-field rules). */
export const VALIDATE_FIRST =
  "Validate first: it is the only channel that reports the cross-field rules a JSON Schema " +
  "cannot express.";

/** Why guessing a document shape is never necessary. */
export const SCHEMA_ON_DEMAND =
  "Never write a document from memory of these descriptions — call get_entity_schema, or read " +
  "the zpecs://schema/ resources.";

/** Both lists derive from domain/enums.ts, so a new value cannot go unmentioned. */
export const STREAM_TYPES_LINE = `Stream types: ${STREAM_TYPE.join(", ")}.`;
export const TASK_TYPES_LINE = `Task types: ${TASK_TYPE.join(", ")}.`;
