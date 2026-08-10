import { z } from "zod";
import {
  acceptanceCriterionId,
  CLAIM_EVIDENCE_SHAPE,
  criterionTypeSchema,
  functionalRequirementId,
  label,
  MEASURABLE_TARGET_SHAPE,
  nfrCategorySchema,
  nonFunctionalRequirementId,
  requirementPrioritySchema,
  requirementId,
  ruleKey,
  statement,
  verificationMethodSchema,
} from "../primitives";
import { ruleText } from "../rules";
import { streamBaseContent } from "./base";

/**
 * A `feature` stream: a new business capability (domain spec §3.2). It adds the
 * two sections that make a capability specifiable and checkable — requirements
 * and acceptance criteria — to the invariant base.
 */

/** One thing the system must do, with MoSCoW priority. */
export const functionalRequirement = z.strictObject({
  id: functionalRequirementId,
  statement,
  priority: requirementPrioritySchema.optional(),
  ...CLAIM_EVIDENCE_SHAPE,
});

/**
 * One quality constraint, expressed as a measurement rather than an adjective.
 * `metric` / `operator` / `target` / `unit` together are what make it verifiable;
 * "should be fast" is the free-text failure the domain spec §14 rejects.
 */
export const nonFunctionalRequirement = z.strictObject({
  id: nonFunctionalRequirementId,
  category: nfrCategorySchema,
  metric: label,
  ...MEASURABLE_TARGET_SHAPE,
  ...CLAIM_EVIDENCE_SHAPE,
});

export const featureRequirements = z.strictObject({
  functional: z.array(functionalRequirement).optional(),
  non_functional: z.array(nonFunctionalRequirement).optional(),
});

/**
 * A given/when/then criterion. `verifies` points back at the requirement and
 * business-rule ids this criterion covers, which is the link that lets a reviewer
 * see an unverified requirement instead of guessing.
 *
 * The domain spec §11 rule "referenced ids must exist" is checked across
 * documents by the service layer, not here — this schema can only see one
 * document — so the rule is quoted in the description as well, because
 * `z.toJSONSchema()` would show the model nothing otherwise.
 */
export const acceptanceCriterionVerifies = z
  .strictObject({
    requirement_ids: z.array(requirementId).optional(),
    rule_keys: z.array(ruleKey).optional(),
  })
  .meta({ description: ruleText("referenced_ids_must_exist") });

export const acceptanceCriterion = z.strictObject({
  id: acceptanceCriterionId,
  type: criterionTypeSchema.optional(),
  given: statement,
  when: statement,
  // `then` is the domain spec's given/when/then vocabulary and part of the wire
  // format, so it is not renameable. The lint rule guards against an object being
  // accidentally awaited; a Zod shape is never awaited, and the runtime value here
  // is a schema, not a plain object with a callable `then`.
  // oxlint-disable-next-line unicorn/no-thenable
  then: statement,
  verifies: acceptanceCriterionVerifies.optional(),
  verification: verificationMethodSchema.optional(),
  ...CLAIM_EVIDENCE_SHAPE,
});

export const featureStreamContent = streamBaseContent.extend({
  requirements: featureRequirements.optional(),
  acceptance_criteria: z
    .array(acceptanceCriterion)
    .optional()
    .meta({ description: ruleText("ready_stream_needs_success_criterion") }),
});
