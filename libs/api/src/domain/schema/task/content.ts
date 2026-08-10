import { z } from "zod";
import { executorKindSchema } from "../../enums";
import {
  acceptanceCriterionId,
  actorRef,
  assumptions,
  behaviorCaseId,
  changeId,
  decisionRuleId,
  entityId,
  estimateConfidenceSchema,
  estimateUnitSchema,
  hypothesisId,
  invariantId,
  investigationQuestionId,
  label,
  maintenanceGoalId,
  openQuestions,
  prose,
  qualityGoalId,
  refactorTargetId,
  requirementId,
  researchQuestionId,
  ruleKey,
  statement,
  statementList,
  streamKey,
  successCriterionId,
  verificationId,
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
 * Which business work this Task carries out. Each field accepts exactly one
 * semantic local-id namespace; the service additionally checks that the field is
 * legal for, and resolves inside, the parent Stream type.
 */
export const taskImplements = z
  .strictObject({
    stream_id: entityId,
    requirement_ids: z.array(requirementId).optional(),
    acceptance_criteria_ids: z.array(acceptanceCriterionId).optional(),
    behavior_case_ids: z.array(behaviorCaseId).optional(),
    change_ids: z.array(changeId).optional(),
    hypothesis_ids: z.array(hypothesisId).optional(),
    research_question_ids: z.array(researchQuestionId).optional(),
    success_criteria_ids: z.array(successCriterionId).optional(),
    decision_rule_ids: z.array(decisionRuleId).optional(),
    investigation_question_ids: z.array(investigationQuestionId).optional(),
    refactor_target_ids: z.array(refactorTargetId).optional(),
    invariant_ids: z.array(invariantId).optional(),
    quality_goal_ids: z.array(qualityGoalId).optional(),
    maintenance_goal_ids: z.array(maintenanceGoalId).optional(),
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
  id: verificationId,
  type: verificationMethodSchema,
  procedure: statement,
  expected: statement,
});

export const taskContent = z.strictObject({
  objective: prose.meta({
    description: "The technical goal, in one or two sentences. The one section a task cannot omit.",
  }),
  implements: taskImplements.optional(),
  /** Rule constraints are not implementation targets and never satisfy Task readiness alone. */
  constrained_by_rule_keys: z.array(ruleKey).optional(),
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
  assumptions: assumptions.optional(),
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

/** The exact parent Stream snapshot a terminal Task says it implemented. */
export const usedStreamRevision = z.strictObject({
  stream_key: streamKey,
  revision: z.int().min(1),
});

/** One canonical Rule snapshot whose constraint a terminal Task used. */
export const usedRuleRevision = z.strictObject({
  rule_key: ruleKey,
  revision: z.int().min(1),
});

/**
 * A terminal Task imported from v1 whose historical execution context cannot be
 * reconstructed without guessing. The migration is the only writer of this
 * marker; normal Task input deliberately has no corresponding field.
 */
export const PRE_V2_TRACE_NOT_RECORDED = "pre_v2_not_recorded" as const;
export const taskTraceState = z.literal(PRE_V2_TRACE_NOT_RECORDED);

/**
 * The task-only fourth content section (domain spec §7), a sibling of `content`
 * rather than part of it. It is separate because it is *operational* rather than
 * specifying: reassigning a task or re-estimating it does not change what the
 * task says to build, and keeping the two apart means a scheduler can read
 * `execution` without loading the whole technical body.
 */
const TASK_EXECUTION_INPUT_SHAPE = {
  estimate: taskEstimate.optional(),
  assignee: actorRef.optional(),
  /** Absent means the executor kind has not been decided, not `either`. */
  executor_kind: executorKindSchema.optional(),
  execution_context: taskExecutionContext.optional(),
  long_running: z.boolean().optional(),
} as const;

/** Operational fields an author may set. Trace pins are server-owned. */
export const taskExecutionInput = z.strictObject(TASK_EXECUTION_INPUT_SHAPE);

/** Stored execution state, including the trace snapshots stamped by the server. */
export const taskExecutionStored = z.strictObject({
  ...TASK_EXECUTION_INPUT_SHAPE,
  /** Server-owned migration marker; current context must never fill this historical gap. */
  trace_state: taskTraceState.optional(),
  /** Server-stamped parent revision when the Task first enters `in_progress`. */
  stream_revision_started: z.int().min(1).optional(),
  /** Server-stamped terminal snapshot for completed or started-then-cancelled work. */
  stream_revision_used: usedStreamRevision.optional(),
  /** Server-stamped terminal Rule snapshots, one per effective canonical Rule. */
  rule_revisions_used: z.array(usedRuleRevision).optional(),
});
