import { z } from "zod";

/**
 * The leaf atoms every document schema is built from, plus the handful of
 * sections that genuinely appear on more than one entity type.
 *
 * Two rules govern what belongs here:
 *
 * 1. **One definition per atom.** A section repeated verbatim in two variant
 *    files is a defect, not DRY-avoidance — if `business_rules` means the same
 *    thing on an epic and on a stream, there is exactly one `businessRules`
 *    here and both import it. Sections that belong to a single entity stay in
 *    that entity's file.
 * 2. **Value sets that back a database column live in `domain/enums.ts`, not
 *    here.** `status`, `stream_type`, `task_type` and `entity_type` are
 *    relational columns (`text().$type<…>()`), so `enums.ts` owns them. The
 *    sets below exist *only* inside the JSON document — no column carries a
 *    priority, a severity or an estimate unit — so duplicating them into
 *    `enums.ts` would put non-column unions in a file whose whole purpose is
 *    to pair a union with its column.
 *
 * The naming convention mirrors `enums.ts` on purpose: `SNAKE_UPPER` array →
 * `camelCaseSchema` validator → `PascalCase` type.
 */

/* ------------------------------------------------------------------ strings */

/**
 * The human-authored section identifiers the domain spec §6/§7 examples use:
 * `FR-001`, `NFR-001`, `AC-001`, `SCOPE-EX-001`, `WF-001`, `STEP-001`,
 * `BR-001`, `EDGE-001`, `VERIFY-001`.
 *
 * A regex rather than a free string because these ids are the join keys between
 * documents — a task's `implements.requirement_ids` points at a stream's
 * `requirements.functional[].id` — and `z.toJSONSchema()` turns the regex into a
 * `pattern` the model can see, which is far cheaper than explaining the
 * convention in prose on every field.
 */
export const sectionId = z
  .string()
  .regex(/^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*$/, "expected an id like FR-001 or SCOPE-EX-001");

/** A stored entity id: `stream_01JREVIEW` in the spec examples, a uuid in the database. */
export const entityId = z.string().min(1).max(128);

/** The human-readable key, `STR-MENU-REVIEW` / `TASK-REVIEW-API` (domain spec §5.3). */
export const entityKey = z.string().min(1).max(128);

/** A one-line human label. */
export const title = z.string().min(1).max(200);

/** A short name from the domain vocabulary: an actor, a unit, an environment. */
export const label = z.string().min(1).max(120);

/** One sentence of domain prose: a rule, a trigger, an expected behaviour. */
export const statement = z.string().min(1).max(2000);

/** A multi-sentence explanation: a purpose, an approach, an objective. */
export const prose = z.string().min(1).max(8000);

/** A free-text list — steps, prerequisites, artifacts. */
export const statementList = z.array(statement);

/** A list of `sectionId`s pointing at sections of this or another document. */
export const sectionIdList = z.array(sectionId);

/* -------------------------------------------------------------- value sets */

/** Business urgency of a whole entity, carried on `meta.priority`. */
export const ENTITY_PRIORITY = ["low", "medium", "high", "critical"] as const;
export type EntityPriority = (typeof ENTITY_PRIORITY)[number];
export const entityPrioritySchema = z.enum(ENTITY_PRIORITY);

/** MoSCoW, on a single requirement. Distinct from `ENTITY_PRIORITY` by design. */
export const REQUIREMENT_PRIORITY = ["must", "should", "could", "wont"] as const;
export type RequirementPriority = (typeof REQUIREMENT_PRIORITY)[number];
export const requirementPrioritySchema = z.enum(REQUIREMENT_PRIORITY);

/** How bad an edge case or a bug is if it happens. */
export const SEVERITY = ["low", "medium", "high", "critical"] as const;
export type Severity = (typeof SEVERITY)[number];
export const severitySchema = z.enum(SEVERITY);

/** The quality dimension a non-functional requirement constrains. */
export const NFR_CATEGORY = [
  "performance",
  "security",
  "reliability",
  "usability",
  "accessibility",
  "compliance",
  "maintainability",
  "observability",
] as const;
export type NfrCategory = (typeof NFR_CATEGORY)[number];
export const nfrCategorySchema = z.enum(NFR_CATEGORY);

/**
 * The comparison in a measurable non-functional requirement. A closed set plus
 * a numeric `target` and a `unit` is what makes an NFR checkable at all; a free
 * string like `"under 2s"` is exactly the single-free-text-field failure the
 * domain spec §14 forbids.
 */
export const COMPARISON_OPERATOR = ["<", "<=", "=", ">=", ">"] as const;
export type ComparisonOperator = (typeof COMPARISON_OPERATOR)[number];
export const comparisonOperatorSchema = z.enum(COMPARISON_OPERATOR);

/** How a criterion or a task is verified. */
export const VERIFICATION_METHOD = [
  "unit_test",
  "integration_test",
  "e2e_test",
  "manual_test",
  "review",
  "measurement",
] as const;
export type VerificationMethod = (typeof VERIFICATION_METHOD)[number];
export const verificationMethodSchema = z.enum(VERIFICATION_METHOD);

/** Whether an acceptance criterion pins behaviour or a quality attribute. */
export const CRITERION_TYPE = ["functional", "non_functional"] as const;
export type CriterionType = (typeof CRITERION_TYPE)[number];
export const criterionTypeSchema = z.enum(CRITERION_TYPE);

/** Where a piece of the document came from (domain spec §5.6). */
export const SOURCE_TYPE = [
  "user_input",
  "conversation",
  "existing_code",
  "documentation",
  "external_reference",
  "inference",
] as const;
export type SourceType = (typeof SOURCE_TYPE)[number];
export const sourceTypeSchema = z.enum(SOURCE_TYPE);

/**
 * How firmly a source supports what was written. `explicit` means the user said
 * it; everything weaker has to be reflected in `open_questions` or
 * `assumptions` (domain spec §5.6 and §11).
 */
export const SOURCE_CONFIDENCE = ["explicit", "implied", "inferred", "assumed"] as const;
export type SourceConfidence = (typeof SOURCE_CONFIDENCE)[number];
export const sourceConfidenceSchema = z.enum(SOURCE_CONFIDENCE);

/** Unit of a task estimate (domain spec §7). */
export const ESTIMATE_UNIT = ["minutes", "hours", "days", "points"] as const;
export type EstimateUnit = (typeof ESTIMATE_UNIT)[number];
export const estimateUnitSchema = z.enum(ESTIMATE_UNIT);

/** Confidence in an estimate. A coarse scale on purpose — a percentage would be invented precision. */
export const ESTIMATE_CONFIDENCE = ["low", "medium", "high"] as const;
export type EstimateConfidence = (typeof ESTIMATE_CONFIDENCE)[number];
export const estimateConfidenceSchema = z.enum(ESTIMATE_CONFIDENCE);

/** Who or what acted: an author, an assignee, a reviewer. */
export const ACTOR_TYPE = ["user", "agent", "planner_agent", "executor_agent", "system"] as const;
export type ActorType = (typeof ACTOR_TYPE)[number];
export const actorTypeSchema = z.enum(ACTOR_TYPE);

/* --------------------------------------------------------- shared sections */

/**
 * An author, assignee or reviewer — `meta.created_by`, `provenance.created_by`
 * and `execution.assignee` all use this shape (domain spec §5.3, §5.6, §7).
 */
export const actorRef = z.strictObject({
  type: actorTypeSchema,
  id: entityId,
});

/**
 * A business rule that constrains behaviour regardless of which workflow
 * triggers it. Shared by epic (cross-cutting rules, §3.1) and stream (§6).
 *
 * `impact` and `consequence` are separate fields rather than one `description`
 * because a rule without a stated consequence is unenforceable in review, and
 * merging them re-creates the free-text blob the domain spec §14 rejects.
 */
export const businessRule = z.strictObject({
  id: sectionId,
  rule: statement,
  impact: statement.optional(),
  consequence: statement.optional(),
});

export const businessRules = z.array(businessRule);

/**
 * What is known to be unknown. Domain spec §11 ("unbekannte Angaben müssen als
 * offene Fragen oder Annahmen markiert werden") and §14 ("erfundene
 * Anforderungen") make this the escape hatch that keeps a draft honest: an
 * agent that does not know something writes it here instead of inventing it.
 */
export const openQuestions = z.array(statement);

/** What was taken as true without confirmation. See `openQuestions`. */
export const assumptions = z.array(statement);

/**
 * The three fields that turn a metric into something checkable: an operator, a
 * numeric target and a unit. Spread into an item rather than nested, because the
 * canonical §6 non-functional requirement has them flat, and shared so that a
 * business success metric on an epic and a quality requirement on a stream are
 * measured the same way.
 */
export const MEASURABLE_TARGET_SHAPE = {
  operator: comparisonOperatorSchema,
  target: z.number(),
  unit: label,
} as const;

/** A scope line: what the entity does or explicitly does not cover. */
export const scopeItem = z.strictObject({
  id: sectionId,
  statement,
});

/**
 * Included / excluded scope. Excluded scope is a first-class list rather than
 * prose because "what is explicitly *not* in this" is one of the seven
 * questions a stream must answer (domain spec §3.2) and the main defence
 * against an agent widening a stream on a later turn.
 */
export const scope = z.strictObject({
  included: z.array(scopeItem),
  excluded: z.array(scopeItem),
});
