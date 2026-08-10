import type { EpicStatus, MilestoneStatus, StreamStatus, StreamType, TaskStatus } from "../enums";
import { ruleIssue, shapeIssue, type DocumentIssue } from "./rules";

/**
 * The draft/ready split, in one place, plus the domain spec §11 gates that hang
 * off it.
 *
 * ## Why the tier is read from the document and never passed in
 *
 * Domain spec §8 allows an incomplete draft, and §11 puts real obligations on a
 * `ready` stream and a `ready` task. So the schemas are permissive and the gates
 * are conditional — which raises the question of what the condition reads.
 *
 * It reads `meta.status`: the status the agent is *writing*. It is deliberately
 * not a `tier` or `draft: true` flag on the call, because a caller-supplied flag
 * is a caller-supplied exemption — an agent would send `draft: true` while
 * writing `status: "ready"` and every §11 gate would evaporate, with the document
 * still landing in the database claiming to be ready. Tying the gate to the
 * written value makes the bypass impossible to express.
 *
 * ## Why `.refine()` is not used for any of this
 *
 * Measured on Zod 4.4.3: `z.toJSONSchema()` silently drops `.refine()` and
 * `.superRefine()`. A gate expressed as a refinement would be invisible in every
 * schema the model sees, so it would fire as a surprise on write. These checks
 * therefore live here as plain functions — `parseDocument` runs them after the
 * shape parses — and each affected field additionally carries the rule text as a
 * `.meta({ description })` so the model can read the obligation up front.
 */

/**
 * Statuses at which the §11 obligations apply, per entity.
 *
 * - Epic: none. `EPIC_STATUS` is a lifecycle (`active | paused | archived`), not
 *   a maturity ladder — an epic is never "more finished" — and domain spec §11
 *   states no epic rule.
 * - Stream: from `ready` on. `planned` sits below `ready` on the §8 ladder and is
 *   still a planning state, and `cancelled` is excluded on purpose: abandoned
 *   work must remain writable, or an agent cannot cancel an incomplete stream.
 * - Task: from `ready` on, same reasoning, including `in_review` and `done`.
 *
 * The `satisfies` clauses tie these lists to `domain/enums.ts`, so renaming a
 * status there is a type error here rather than a silently dead gate.
 */
const READY_TIER_STATUS = {
  epic: [] as readonly EpicStatus[],
  stream: ["ready", "in_progress", "blocked", "completed"] satisfies readonly StreamStatus[],
  task: ["ready", "in_progress", "blocked", "in_review", "done"] satisfies readonly TaskStatus[],
} as const;

export type DocumentTier = "draft" | "ready";

/** Which tier a written status puts the document in. The only definition of the split. */
export const documentTier = (
  entity: keyof typeof READY_TIER_STATUS,
  status: string,
): DocumentTier =>
  (READY_TIER_STATUS[entity] as readonly string[]).includes(status) ? "ready" : "draft";

/** A section counts as present only if it is a non-empty array. `[]` is not an answer. */
const filled = (value: unknown): boolean => Array.isArray(value) && value.length > 0;

/** A scalar section counts as present only if it is a non-blank string. */
const stated = (value: unknown): boolean => typeof value === "string" && value.trim().length > 0;

const at = (content: unknown, key: string): unknown =>
  typeof content === "object" && content !== null
    ? (content as Record<string, unknown>)[key]
    : undefined;

/**
 * The §11 gates for a stream at `ready` or beyond.
 *
 * "Ein `ready`-Stream braucht ein passendes fachliches Erfolgskriterium" — and
 * *passend* is the whole point, so what counts differs by type:
 *
 * Every type now has addressable business targets. A `ready` Stream therefore
 * has to contain the minimum set that makes its own kind actionable; drafts and
 * planned Streams remain deliberately incomplete.
 */
export const streamReadinessIssues = (
  streamType: StreamType,
  status: string,
  content: unknown,
): readonly DocumentIssue[] => {
  if (documentTier("stream", status) === "draft") return [];

  const issues: DocumentIssue[] = [];

  if (streamType === "feature" && !filled(at(content, "acceptance_criteria"))) {
    issues.push(ruleIssue("ready_stream_needs_success_criterion", "content.acceptance_criteria"));
  }

  if (streamType === "bug" && !filled(at(content, "behavior_cases"))) {
    issues.push(
      ruleIssue("ready_bug_needs_actual_and_expected_behavior", "content.behavior_cases"),
    );
  }

  if (streamType === "change" && !filled(at(content, "changes"))) {
    issues.push(ruleIssue("ready_stream_needs_success_criterion", "content.changes"));
  }

  if (streamType === "experiment") {
    for (const field of ["hypotheses", "success_criteria", "decision_rules"] as const) {
      if (!filled(at(content, field))) {
        issues.push(ruleIssue("ready_stream_needs_success_criterion", `content.${field}`));
      }
    }
  }

  if (streamType === "investigation") {
    if (!filled(at(content, "questions"))) {
      issues.push(ruleIssue("ready_stream_needs_success_criterion", "content.questions"));
    }
    if (!filled(at(content, "success_criteria")) && !stated(at(content, "expected_decision"))) {
      issues.push(
        ruleIssue("success_criteria_may_replace_acceptance_criteria", "content.success_criteria"),
      );
    }
  }

  if (streamType === "refactor") {
    for (const field of ["refactor_targets", "invariants"] as const) {
      if (!filled(at(content, field))) {
        issues.push(ruleIssue("ready_stream_needs_success_criterion", `content.${field}`));
      }
    }
  }

  if (streamType === "maintenance" && !filled(at(content, "maintenance_goals"))) {
    issues.push(ruleIssue("ready_stream_needs_success_criterion", "content.maintenance_goals"));
  }

  return issues;
};

/**
 * The §11 gates for a Task at `ready` or beyond: a technical definition of done,
 * and at least one typed reference to the business work it serves. The parent
 * Stream type and existence checks belong to the cross-document service layer.
 *
 * `done_when` and `verification` are both required at this tier because they
 * answer different questions — what "finished" means, and how anyone would know.
 * A task with only `done_when` states an intention nobody can check.
 */
export const taskReadinessIssues = (status: string, content: unknown): readonly DocumentIssue[] => {
  if (documentTier("task", status) === "draft") return [];

  const issues: DocumentIssue[] = [];

  if (!filled(at(content, "done_when")) || !filled(at(content, "verification"))) {
    issues.push(
      ruleIssue(
        "ready_task_needs_definition_of_done",
        filled(at(content, "done_when")) ? "content.verification" : "content.done_when",
      ),
    );
  }

  const implementsSection = at(content, "implements");
  const hasStream = stated(at(implementsSection, "stream_id"));
  const hasReference = [
    "requirement_ids",
    "acceptance_criteria_ids",
    "behavior_case_ids",
    "change_ids",
    "hypothesis_ids",
    "research_question_ids",
    "success_criteria_ids",
    "decision_rule_ids",
    "investigation_question_ids",
    "refactor_target_ids",
    "invariant_ids",
    "quality_goal_ids",
    "maintenance_goal_ids",
  ].some((field) => filled(at(implementsSection, field)));
  if (!hasStream || !hasReference) {
    issues.push(ruleIssue("task_references_business_requirements", "content.implements"));
  }

  return issues;
};

/** Milestone lifecycle gates. Ordering remains advisory and has no date semantics. */
export const milestoneReadinessIssues = (
  status: string,
  content: unknown,
): readonly DocumentIssue[] => {
  const lifecycle = status as MilestoneStatus;
  if (lifecycle === "draft" || lifecycle === "cancelled") return [];

  const criteria = at(content, "exit_criteria");
  if (!filled(criteria)) {
    return [
      shapeIssue(
        "content.exit_criteria",
        `A ${lifecycle} Milestone needs at least one explicit exit criterion.`,
      ),
    ];
  }
  if (lifecycle !== "completed" || !Array.isArray(criteria)) return [];

  return criteria.flatMap((criterion, index) => {
    const criterionStatus = at(criterion, "status");
    if (criterionStatus !== "met" && criterionStatus !== "waived") {
      return [
        shapeIssue(
          `content.exit_criteria[${String(index)}].status`,
          "A completed Milestone requires every exit criterion to be met or explicitly waived.",
        ),
      ];
    }
    if (criterionStatus === "waived" && !stated(at(criterion, "waiver_reason"))) {
      return [
        shapeIssue(
          `content.exit_criteria[${String(index)}].waiver_reason`,
          "A waived exit criterion needs a reason.",
        ),
      ];
    }
    return [];
  });
};
