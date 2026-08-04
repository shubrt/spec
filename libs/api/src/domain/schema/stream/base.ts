import { z } from "zod";
import {
  assumptions,
  businessRules,
  label,
  openQuestions,
  prose,
  scope,
  sectionId,
  severitySchema,
  statement,
  statementList,
  title,
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
 * `streamBaseContent` is directly usable, and `stream/registry.ts` maps the four
 * stream types with no dedicated schema yet straight onto it. The three variants
 * `.extend()` it, which (measured on Zod 4.4.3) preserves the `strictObject`
 * behaviour and therefore `additionalProperties: false`.
 */

/** One step in a business workflow (domain spec §6). */
export const workflowStep = z.strictObject({
  id: sectionId,
  action: statement,
  result: statement.optional(),
});

/**
 * A business flow through the stream. `steps` is required: a named workflow with
 * no steps carries no information, and an agent that cannot name a step should
 * not be naming the workflow yet.
 */
export const workflow = z.strictObject({
  id: sectionId,
  workflow_name: title,
  actor: label.optional(),
  preconditions: statementList.optional(),
  steps: z.array(workflowStep),
});

/**
 * A situation the happy path does not cover. `trigger` and `expected_behavior`
 * are required because an edge case without a stated expectation is a note, not
 * a specification.
 */
export const edgeCase = z.strictObject({
  id: sectionId,
  trigger: statement,
  scenario: statement.optional(),
  expected_behavior: statement,
  severity: severitySchema.optional(),
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
});

/**
 * The invariant stream sections. The three variants in this directory extend
 * this; the other four stream types use it unchanged.
 */
export const streamBaseContent = z.strictObject({
  purpose: prose.meta({
    description: "Why this stream exists, in business terms. The one section a stream cannot omit.",
  }),
  scope: scope.optional(),
  actor: streamActor.optional(),
  workflows: z.array(workflow).optional(),
  business_rules: businessRules.optional(),
  edge_cases: z.array(edgeCase).optional(),
  vertical_slice: verticalSlice.optional(),
  open_questions: openQuestions.optional(),
  assumptions: assumptions.optional(),
});

export type StreamBaseContent = z.infer<typeof streamBaseContent>;
