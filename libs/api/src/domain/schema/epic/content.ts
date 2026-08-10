import { z } from "zod";
import {
  assumptions,
  CLAIM_EVIDENCE_SHAPE,
  label,
  MEASURABLE_TARGET_SHAPE,
  metricId,
  openQuestions,
  outcomeId,
  prose,
  ruleApplications,
  scope,
  statement,
} from "../primitives";

/**
 * Epic content: a long-lived business capability (domain spec §3.1, §5.4).
 *
 * The section list is the one the spec gives — purpose, business problem, scope,
 * outcomes, success metrics, business rules — and nothing else. In particular an
 * epic has no requirements, no acceptance criteria and no workflows: those belong
 * to a stream, and the whole point of the Epic → Stream split (domain spec §4) is
 * that the epic states the standing "why" while streams state the bounded "what".
 *
 * `scope` and `rule_applications` are shared atoms: an epic applies canonical
 * project Rules across its streams without copying their text.
 *
 * As with a stream, only `purpose` is structurally required. Epics have no
 * readiness gate at all — `EPIC_STATUS` is `active | paused | archived`, a
 * lifecycle rather than a maturity ladder, so there is no status at which extra
 * sections become obligatory (domain spec §11 names no epic rule).
 */

/** A business result the epic is meant to produce. */
export const epicOutcome = z.strictObject({
  id: outcomeId,
  outcome: statement,
  /** How the business would notice this outcome happening. */
  indicator: statement.optional(),
  ...CLAIM_EVIDENCE_SHAPE,
});

/**
 * A business metric the epic moves, expressed as a measurement. Shares
 * `MEASURABLE_TARGET_SHAPE` with a stream's non-functional requirement so that
 * "target 2 seconds" and "target 30 percent" are stated the same way; `baseline`
 * is the difference, because a business metric is only meaningful against where
 * it started.
 */
export const epicSuccessMetric = z.strictObject({
  id: metricId,
  metric: label,
  baseline: z.number().optional(),
  ...MEASURABLE_TARGET_SHAPE,
  ...CLAIM_EVIDENCE_SHAPE,
});

export const epicContent = z.strictObject({
  purpose: prose.meta({
    description:
      "The standing business capability this epic represents. Not a deliverable and not time-boxed.",
  }),
  business_problem: prose.optional(),
  scope: scope.optional().meta({
    description: "The long-horizon scope of the capability, not the scope of any one change.",
  }),
  outcomes: z.array(epicOutcome).optional(),
  success_metrics: z.array(epicSuccessMetric).optional(),
  rule_applications: ruleApplications.optional().meta({
    description: "Canonical project Rules that apply across this epic and its streams.",
  }),
  open_questions: openQuestions.optional(),
  assumptions: assumptions.optional(),
});
