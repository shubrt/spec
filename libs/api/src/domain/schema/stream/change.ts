import { z } from "zod";
import { changeId, CLAIM_EVIDENCE_SHAPE, statement } from "../primitives";
import { streamBaseContent } from "./base";

/** One bounded transition from a known current state to a desired state. */
export const changeTarget = z.strictObject({
  id: changeId,
  trigger: statement.optional(),
  current_state: statement,
  desired_state: statement,
  success_measure: statement.optional(),
  ...CLAIM_EVIDENCE_SHAPE,
});

export const changeStreamContent = streamBaseContent.extend({
  changes: z.array(changeTarget).optional().meta({
    description: "A change Stream needs at least one CHG-* target before it may become ready.",
  }),
});
