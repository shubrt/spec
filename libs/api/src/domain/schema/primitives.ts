import { z } from "zod";

/**
 * The leaf atoms every document schema is built from, plus the handful of
 * sections that genuinely appear on more than one entity type.
 *
 * Two rules govern what belongs here:
 *
 * 1. **One definition per atom.** A section repeated verbatim in two variant
 *    files is a defect, not DRY-avoidance. Sections that belong to a single
 *    entity stay in that entity's file.
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
 * V2 local ids are unique inside `(owner, semantic namespace)`, not project-wide.
 * Their numeric component is canonical: `FR-1` and `FR-10` are valid, while
 * `FR-0` and zero-padded `FR-01` are not. Dedicated schemas make a typed
 * reference incapable of accepting an id from the wrong namespace.
 */
export const LOCAL_ID_PREFIX = [
  "SCP",
  "OUT",
  "MET",
  "FR",
  "NFR",
  "AC",
  "WF",
  "STEP",
  "EC",
  "RA",
  "ASM",
  "OQ",
  "SRC",
  "EXIT",
  "VER",
  "BC",
  "CHG",
  "HYP",
  "RQ",
  "SC",
  "DR",
  "IQ",
  "REF",
  "INV",
  "QG",
  "MG",
  "RSK",
] as const;
export type LocalIdPrefix = (typeof LOCAL_ID_PREFIX)[number];

const localIdSchema = <const Prefix extends LocalIdPrefix>(prefix: Prefix) =>
  z
    .string()
    .regex(
      new RegExp(`^${prefix}-[1-9][0-9]*$`),
      `expected ${prefix}- followed by a positive integer without zero padding, for example ${prefix}-1`,
    );

export const scopeId = localIdSchema("SCP");
export const outcomeId = localIdSchema("OUT");
export const metricId = localIdSchema("MET");
export const functionalRequirementId = localIdSchema("FR");
export const nonFunctionalRequirementId = localIdSchema("NFR");
export const acceptanceCriterionId = localIdSchema("AC");
export const workflowId = localIdSchema("WF");
export const workflowStepId = localIdSchema("STEP");
export const edgeCaseId = localIdSchema("EC");
export const ruleApplicationId = localIdSchema("RA");
export const assumptionId = localIdSchema("ASM");
export const openQuestionId = localIdSchema("OQ");
export const sourceId = localIdSchema("SRC");
export const exitCriterionId = localIdSchema("EXIT");
export const verificationId = localIdSchema("VER");
export const behaviorCaseId = localIdSchema("BC");
export const changeId = localIdSchema("CHG");
export const hypothesisId = localIdSchema("HYP");
export const researchQuestionId = localIdSchema("RQ");
export const successCriterionId = localIdSchema("SC");
export const decisionRuleId = localIdSchema("DR");
export const investigationQuestionId = localIdSchema("IQ");
export const refactorTargetId = localIdSchema("REF");
export const invariantId = localIdSchema("INV");
export const qualityGoalId = localIdSchema("QG");
export const maintenanceGoalId = localIdSchema("MG");
export const riskId = localIdSchema("RSK");

/** Any v2 local id. Prefer a namespace-specific schema whenever the kind is known. */
export const sectionId = z
  .string()
  .regex(
    new RegExp(`^(?:${LOCAL_ID_PREFIX.join("|")})-[1-9][0-9]*$`),
    "expected a known local-id prefix and a positive integer without zero padding",
  );

/** Functional and non-functional requirements intentionally share one reference field. */
export const requirementId = z
  .string()
  .regex(
    /^(?:FR|NFR)-[1-9][0-9]*$/,
    "expected FR- or NFR- followed by a positive integer without zero padding",
  );

/** A stored entity id: `stream_01JREVIEW` in the spec examples, a uuid in the database. */
export const entityId = z.string().min(1).max(128);

/** The generated human-readable key, such as `S-12` or `T-45` (domain spec §5.3). */
export const entityKey = z.string().min(1).max(128);

/** A canonical project-scoped Stream key. */
export const streamKey = z
  .string()
  .regex(/^S-[1-9][0-9]*$/, "expected a Stream key like S-1 without zero padding");

/** A canonical project-scoped Milestone key. */
export const milestoneKey = z
  .string()
  .regex(/^M-[1-9][0-9]*$/, "expected a Milestone key like M-1 without zero padding");

/** A canonical project-scoped Rule key. Resolution and existence are service concerns. */
export const ruleKey = z
  .string()
  .regex(
    /^(?:R-[1-9][0-9]*|\$[a-z][a-z0-9_]{0,39})$/,
    "expected a Rule key like R-1, or a $temp Rule declared earlier in this change set",
  );

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

/** A generic local-id list. Typed reference fields use their dedicated schemas instead. */
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

/** Where an immutable source observation came from. Inference is a claim basis, not a source. */
export const SOURCE_TYPE = [
  "user_input",
  "conversation",
  "existing_code",
  "documentation",
  "external_reference",
] as const;
export type SourceType = (typeof SOURCE_TYPE)[number];
export const sourceTypeSchema = z.enum(SOURCE_TYPE);

/** How a particular claim was established. This belongs to the claim, never the source. */
export const CLAIM_BASIS = ["stated", "verified", "inferred", "assumed"] as const;
export type ClaimBasis = (typeof CLAIM_BASIS)[number];
export const claimBasisSchema = z.enum(CLAIM_BASIS);

/** Coarse planning size for a Stream. Absence means nobody has sized it yet. */
export const STREAM_SIZE = ["small", "medium", "large"] as const;
export type StreamSize = (typeof STREAM_SIZE)[number];
export const streamSizeSchema = z.enum(STREAM_SIZE);

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
 * An externally identified assignee or reviewer. Document authorship lives in
 * the server-owned revision log rather than being duplicated in document JSON.
 */
export const actorRef = z.strictObject({
  type: actorTypeSchema,
  id: entityId,
});

/**
 * Compact claim-level provenance. `stated`, `verified` and `inferred` cite at
 * least one local Source; that cross-field and cross-section rule is enforced by
 * the service so it remains visible in generated JSON Schema rather than hiding
 * inside a dropped Zod refinement. An assumed claim may have no source.
 */
export const claimEvidence = z
  .strictObject({
    basis: claimBasisSchema,
    source_ids: z.array(sourceId).min(1).optional(),
  })
  .meta({
    description:
      "Claim provenance. stated, verified and inferred require at least one source_ids entry; assumed may omit it. Source ids resolve in this document's provenance.sources.",
  });

/** Spread into one addressable item that carries a business assertion. */
export const CLAIM_EVIDENCE_SHAPE = {
  evidence: claimEvidence.optional(),
} as const;

/** A local application of one canonical project Rule, never a local text override. */
export const ruleApplication = z.strictObject({
  id: ruleApplicationId,
  rule_key: ruleKey,
  applies_when: statement.optional(),
  application: statement.optional(),
  ...CLAIM_EVIDENCE_SHAPE,
});

export const ruleApplications = z.array(ruleApplication);

/**
 * What is known to be unknown. Domain spec §11 ("unbekannte Angaben müssen als
 * offene Fragen oder Annahmen markiert werden") and §14 ("erfundene
 * Anforderungen") make this the escape hatch that keeps a draft honest: an
 * agent that does not know something writes it here instead of inventing it.
 */
export const openQuestion = z.strictObject({
  id: openQuestionId,
  question: statement,
});

export const openQuestions = z.array(openQuestion);

/** The container already makes the basis `assumed`; source ids only explain what suggested it. */
export const assumption = z.strictObject({
  id: assumptionId,
  statement,
  source_ids: z.array(sourceId).min(1).optional(),
});

export const assumptions = z.array(assumption);

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
  id: scopeId,
  statement,
  ...CLAIM_EVIDENCE_SHAPE,
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
