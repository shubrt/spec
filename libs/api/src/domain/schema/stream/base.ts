import { z } from "zod";
import {
  assumptions,
  CLAIM_EVIDENCE_SHAPE,
  edgeCaseId,
  label,
  openQuestions,
  prose,
  ruleApplications,
  scope,
  severitySchema,
  statement,
  statementList,
  title,
  workflowId,
  workflowStepId,
} from "../primitives";

/**
 * The sections every stream has, whatever its type (domain spec §6).
 *
 * ## Why almost everything is optional
 *
 * Domain spec §8 is explicit: "Ein Stream darf als früher Draft unvollständig
 * sein." An agent that has just heard one sentence from a user must be able to
 * write a stream at `status: "draft"` with a purpose and nothing else, and then
 * fill it in over later turns. Making `scope` or `workflows` structurally
 * required would force the agent to invent them on the first turn, which is
 * precisely the failure the domain spec §14 names ("erfundene Anforderungen bei
 * unklaren Nutzerangaben").
 *
 * The rigour therefore does not live in "required" — it lives in the readiness
 * gates in `readiness.ts`, which key off the *written* status. A draft may be
 * skeletal; a stream that claims `ready` must earn it. `purpose` is the single
 * exception: a stream whose purpose is unknown is not a stream.
 *
 * ## Why this is a schema and not just a shape
 *
 * Every concrete variant in `stream/registry.ts` extends this schema. Measured
 * on Zod 4.4.3, `.extend()` preserves the `strictObject` behaviour and therefore
 * `additionalProperties: false`.
 */

/** One step in a business workflow (domain spec §6). */
export const workflowStep = z.strictObject({
  id: workflowStepId,
  action: statement,
  result: statement.optional(),
  ...CLAIM_EVIDENCE_SHAPE,
});

/**
 * A business flow through the stream. `steps` is required: a named workflow with
 * no steps carries no information, and an agent that cannot name a step should
 * not be naming the workflow yet.
 */
export const workflow = z.strictObject({
  id: workflowId,
  workflow_name: title,
  actor: label.optional(),
  preconditions: statementList.optional(),
  steps: z.array(workflowStep),
  ...CLAIM_EVIDENCE_SHAPE,
});

/**
 * A situation the happy path does not cover. `trigger` and `expected_behavior`
 * are required because an edge case without a stated expectation is a note, not
 * a specification.
 */
export const edgeCase = z.strictObject({
  id: edgeCaseId,
  trigger: statement,
  scenario: statement.optional(),
  expected_behavior: statement,
  severity: severitySchema.optional(),
  ...CLAIM_EVIDENCE_SHAPE,
});

/**
 * Who the stream is for. `primary` is the one actor whose need the stream exists
 * to serve; a stream with several equally primary actors is usually two streams.
 */
export const streamActor = z.strictObject({
  primary: label,
  secondary: z.array(label).optional(),
});

/**
 * What this stream delivers on its own (domain spec §6). The point of the
 * section is to force the question "is this shippable by itself?" — a stream that
 * needs three other streams before anyone notices it is not a vertical slice.
 */
export const verticalSlice = z.strictObject({
  delivers_alone: statement,
  needs_no_other_stream: z.boolean().optional(),
  prerequisites: statementList.optional(),
  ...CLAIM_EVIDENCE_SHAPE,
});

/**
 * The invariant Stream sections shared by all seven type-specific schemas.
 */
export const streamBaseContent = z.strictObject({
  purpose: prose.meta({
    description: "Why this stream exists, in business terms. The one section a stream cannot omit.",
  }),
  scope: scope.optional(),
  actor: streamActor.optional(),
  workflows: z.array(workflow).optional(),
  rule_applications: ruleApplications.optional(),
  edge_cases: z.array(edgeCase).optional(),
  vertical_slice: verticalSlice.optional(),
  open_questions: openQuestions.optional(),
  assumptions: assumptions.optional(),
});
