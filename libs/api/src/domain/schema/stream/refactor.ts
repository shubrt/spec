import { z } from "zod";
import {
  CLAIM_EVIDENCE_SHAPE,
  invariantId,
  qualityGoalId,
  refactorTargetId,
  statement,
} from "../primitives";
import { streamBaseContent } from "./base";

/** One technical structure to improve without changing its promised behaviour. */
export const refactorTarget = z.strictObject({
  id: refactorTargetId,
  current_state: statement,
  target_state: statement,
  ...CLAIM_EVIDENCE_SHAPE,
});

/** Behaviour or compatibility that the refactor must preserve. */
export const refactorInvariant = z.strictObject({
  id: invariantId,
  statement,
  ...CLAIM_EVIDENCE_SHAPE,
});

/** The improvement sought, with a measurement where one is practical. */
export const qualityGoal = z.strictObject({
  id: qualityGoalId,
  goal: statement,
  measurement: statement.optional(),
  ...CLAIM_EVIDENCE_SHAPE,
});

export const refactorStreamContent = streamBaseContent.extend({
  refactor_targets: z.array(refactorTarget).optional().meta({
    description: "A refactor needs at least one REF-* target before it may become ready.",
  }),
  invariants: z.array(refactorInvariant).optional().meta({
    description: "A refactor needs at least one INV-* invariant before it may become ready.",
  }),
  quality_goals: z.array(qualityGoal).optional(),
});
