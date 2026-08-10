import { z } from "zod";
import {
  CLAIM_EVIDENCE_SHAPE,
  decisionRuleId,
  hypothesisId,
  researchQuestionId,
  statement,
} from "../primitives";
import { streamBaseContent } from "./base";
import { successCriterion } from "./shared";

/** A falsifiable proposition the experiment is intended to evaluate. */
export const experimentHypothesis = z.strictObject({
  id: hypothesisId,
  hypothesis: statement,
  ...CLAIM_EVIDENCE_SHAPE,
});

/** A question whose answer reduces uncertainty around the hypothesis. */
export const researchQuestion = z.strictObject({
  id: researchQuestionId,
  question: statement,
  why_it_matters: statement.optional(),
  ...CLAIM_EVIDENCE_SHAPE,
});

/** How an observed condition turns into a decision after the experiment. */
export const decisionRule = z.strictObject({
  id: decisionRuleId,
  condition: statement,
  decision: statement,
  ...CLAIM_EVIDENCE_SHAPE,
});

export const experimentStreamContent = streamBaseContent.extend({
  hypotheses: z.array(experimentHypothesis).optional().meta({
    description: "An experiment needs at least one HYP-* hypothesis before it may become ready.",
  }),
  research_questions: z.array(researchQuestion).optional(),
  success_criteria: z.array(successCriterion).optional().meta({
    description: "An experiment needs at least one measurable SC-* finish line before ready.",
  }),
  decision_rules: z.array(decisionRule).optional().meta({
    description: "An experiment needs at least one DR-* rule that turns results into a decision.",
  }),
});
