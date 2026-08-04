import { z } from "zod";
import {
  actorRef,
  entityId,
  estimateConfidenceSchema,
  estimateUnitSchema,
  label,
  openQuestions,
  prose,
  sectionId,
  sectionIdList,
  statement,
  statementList,
  verificationMethodSchema,
} from "../primitives";
import { ruleText } from "../rules";

/**
 * Task content and the task-only `execution` section (domain spec §7).
 *
 * A task is the technical "how" (domain spec §4). It carries no business
 * requirements of its own — it *references* them through `implements`, which is
 * the link that keeps "what" and "why" out of the task while staying traceable.
 * Domain spec §14 names "Tasks ohne Referenz zu fachlichen Anforderungen" as a
 * thing to avoid, and `readiness.ts` turns that into a gate at `ready`.
 */

/**
 * Which business work this task carries out. The ids point into the parent
 * stream's `requirements` and `acceptance_criteria`; whether they resolve is a
 * cross-document question the service layer answers, so the rule is also spelled
 * out in the description where the model can see it.
 */
export const taskImplements = z
  .strictObject({
    stream_id: entityId,
    requirement_ids: sectionIdList.optional(),
    acceptance_criteria_ids: sectionIdList.optional(),
  })
  .meta({ description: ruleText("task_references_business_requirements") });

/**
 * The technical surface the task touches. Five plain name lists rather than
 * prose: they are what a reviewer scans to spot two tasks colliding on the same
 * component, and what a future impact query would filter on.
 */
export const technicalScope = z.strictObject({
  repositories: z.array(label).optional(),
  services: z.array(label).optional(),
  components: z.array(label).optional(),
  interfaces: z.array(label).optional(),
  data_models: z.array(label).optional(),
});

/**
 * A technical decision and, crucially, its reason. The domain spec §7 example has
 * no `id` on these — a decision is identified by its text, and inventing an id
 * scheme the spec does not have would be exactly the kind of drift this layer
 * exists to prevent.
 */
export const technicalDecision = z.strictObject({
  decision: statement,
  reason: statement,
  alternatives_considered: statementList.optional(),
});

export const taskImplementation = z.strictObject({
  approach: prose,
  steps: statementList.optional(),
  technical_decisions: z.array(technicalDecision).optional(),
});

/** How the task will be shown to work. */
export const taskVerification = z.strictObject({
  id: sectionId,
  type: verificationMethodSchema,
  procedure: statement,
  expected: statement,
});

export const taskContent = z.strictObject({
  objective: prose.meta({
    description: "The technical goal, in one or two sentences. The one section a task cannot omit.",
  }),
  implements: taskImplements.optional(),
  technical_scope: technicalScope.optional(),
  implementation: taskImplementation.optional(),
  /** Technical prerequisites in prose. Task-to-task ordering belongs in `links`, not here. */
  dependencies: statementList.optional(),
  verification: z
    .array(taskVerification)
    .optional()
    .meta({ description: ruleText("ready_task_needs_definition_of_done") }),
  done_when: statementList
    .optional()
    .meta({ description: ruleText("ready_task_needs_definition_of_done") }),
  artifacts: statementList.optional(),
  open_questions: openQuestions.optional(),
});

/* ------------------------------------------------------- execution section */

/** Effort, deliberately coarse. Domain spec §3.3 sets no hard time limit on a task. */
export const taskEstimate = z.strictObject({
  value: z.number().positive(),
  unit: estimateUnitSchema,
  confidence: estimateConfidenceSchema.optional(),
});

/**
 * Runtime hints for whoever picks the task up.
 *
 * The domain spec §7 example shows this as an empty object, which invites an open
 * bag. It is a closed `strictObject` of optional fields instead: an
 * arbitrary-key section would be the one hole through which the §14 rule "no
 * invented fields" leaks, since anything an agent could not fit elsewhere would
 * end up here. `checkpoints` is from domain spec §3.3, which structures
 * long-running work through checkpoints and expected artifacts.
 */
export const taskExecutionContext = z.strictObject({
  environment: label.optional(),
  checkpoints: statementList.optional(),
  notes: statementList.optional(),
});

/**
 * The task-only fourth content section (domain spec §7), a sibling of `content`
 * rather than part of it. It is separate because it is *operational* rather than
 * specifying: reassigning a task or re-estimating it does not change what the
 * task says to build, and keeping the two apart means a scheduler can read
 * `execution` without loading the whole technical body.
 */
export const taskExecution = z.strictObject({
  estimate: taskEstimate.optional(),
  assignee: actorRef.optional(),
  execution_context: taskExecutionContext.optional(),
  long_running: z.boolean().optional(),
});
