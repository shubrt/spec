import { z } from "zod";
import {
  behaviorCaseId,
  CLAIM_EVIDENCE_SHAPE,
  severitySchema,
  statement,
  statementList,
} from "../primitives";
import { ruleText } from "../rules";
import { streamBaseContent } from "./base";

/**
 * A `bug` stream: fix wrong behaviour (domain spec §3.2, §6).
 *
 * Each `BC-*` item keeps reproduction, actual behaviour and expected behaviour
 * together as one addressable defect claim. It is deliberately not a user story.
 *
 * The array is optional so an early bug report can still be a correct draft. An
 * item itself requires both behaviours; `readiness.ts` requires at least one item
 * before the Stream may claim `ready`.
 */

export const behaviorCase = z.strictObject({
  id: behaviorCaseId,
  reproduction: statementList.optional(),
  actual_behavior: statement,
  expected_behavior: statement,
  severity: severitySchema.optional(),
  ...CLAIM_EVIDENCE_SHAPE,
});

export const bugStreamContent = streamBaseContent.extend({
  behavior_cases: z
    .array(behaviorCase)
    .optional()
    .meta({ description: ruleText("ready_bug_needs_actual_and_expected_behavior") }),
});
