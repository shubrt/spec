import { z } from "zod";
import {
  CLAIM_EVIDENCE_SHAPE,
  maintenanceGoalId,
  riskId,
  severitySchema,
  statement,
} from "../primitives";
import { streamBaseContent } from "./base";

/** One operational upkeep result with an explicit finish condition. */
export const maintenanceGoal = z.strictObject({
  id: maintenanceGoalId,
  goal: statement,
  done_when: statement,
  ...CLAIM_EVIDENCE_SHAPE,
});

/** A maintenance risk constrains execution but is not itself a Task readiness target. */
export const maintenanceRisk = z.strictObject({
  id: riskId,
  risk: statement,
  mitigation: statement.optional(),
  severity: severitySchema.optional(),
  ...CLAIM_EVIDENCE_SHAPE,
});

export const maintenanceStreamContent = streamBaseContent.extend({
  maintenance_goals: z.array(maintenanceGoal).optional().meta({
    description: "A maintenance Stream needs at least one MG-* goal before it may become ready.",
  }),
  risks: z.array(maintenanceRisk).optional(),
});
