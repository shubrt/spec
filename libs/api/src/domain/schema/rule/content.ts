import { z } from "zod";
import { assumptions, claimEvidence, openQuestions, prose, statement } from "../primitives";

/**
 * One canonical project Rule. Local Epic/Stream applications may narrow when it
 * applies, but they never override this definition's text.
 */
export const ruleContent = z.strictObject({
  statement,
  rationale: prose.optional(),
  impact: statement.optional(),
  consequence: statement.optional(),
  evidence: claimEvidence.optional(),
  open_questions: openQuestions.optional(),
  assumptions: assumptions.optional(),
});
