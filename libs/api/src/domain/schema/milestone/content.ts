import { z } from "zod";
import { exitCriterionStatusSchema } from "../../enums";
import {
  assumptions,
  CLAIM_EVIDENCE_SHAPE,
  exitCriterionId,
  openQuestions,
  prose,
  statement,
} from "../primitives";

/** An explicit, auditable condition for leaving a Milestone. */
export const milestoneExitCriterion = z.strictObject({
  id: exitCriterionId,
  criterion: statement,
  status: exitCriterionStatusSchema.default("open"),
  /** Required by readiness when status is waived; optional in drafts. */
  waiver_reason: statement.optional(),
  ...CLAIM_EVIDENCE_SHAPE,
});

export const milestoneContent = z.strictObject({
  goal: prose,
  exit_criteria: z.array(milestoneExitCriterion).optional(),
  open_questions: openQuestions.optional(),
  assumptions: assumptions.optional(),
});
