import { z } from "zod";
import { CLAIM_EVIDENCE_SHAPE, statement, successCriterionId } from "../primitives";

/** A measurable finish line shared by experiments and investigations. */
export const successCriterion = z.strictObject({
  id: successCriterionId,
  criterion: statement,
  measurement: statement.optional(),
  ...CLAIM_EVIDENCE_SHAPE,
});
