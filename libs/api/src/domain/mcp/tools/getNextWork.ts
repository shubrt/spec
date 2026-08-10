import { z } from "zod";
import {
  DEFAULT_NEXT_WORK_LIMIT,
  MAX_NEXT_WORK_LIMIT,
  NEXT_WORK_EXECUTOR_FILTER,
  type NextWorkItem,
  type NextWorkResult,
  type NextWorkSubject,
  nextWorkService,
} from "../../service/nextWork";
import { referenceService } from "../../service/reference";
import { defineTool } from "../defineTool";
import { TOOL_ERROR_CODE, keyLookupError, textResult, toolError } from "../results";

/**
 * Selects executable Tasks and Streams that need planning from a Project,
 * Milestone, Epic, or Stream. Roadmap scope filters and sorts; it never becomes
 * a dependency.
 */
const getNextWorkInput = z.strictObject({
  key: z.string().min(1).max(64).optional(),
  project: z.string().min(1).max(200).optional(),
  executor: z.enum(NEXT_WORK_EXECUTOR_FILTER).optional(),
  limit: z.number().int().min(1).max(MAX_NEXT_WORK_LIMIT).default(DEFAULT_NEXT_WORK_LIMIT),
});

const renderItem = (item: NextWorkItem): string => {
  const priority = item.priority ?? "unprioritised";
  if (item.kind === "stream_planning") {
    return `- ${item.key} [stream_planning, ${item.streamType}, ${item.status}, ${priority}] ${item.title} — ${item.reason}`;
  }
  const executor = item.executorKind ?? "executor_unknown";
  return `- ${item.key} [task_execution, ${item.taskType}, ${item.status}, ${executor}, ${priority}] ${item.title} — in ${item.streamKey} [${item.streamStatus}] ${item.streamTitle}`;
};

const renderCauses = (result: NextWorkResult): string[] => {
  const lines: string[] = [];
  const add = (code: string, count: number, explanation: string): void => {
    if (count > 0) {
      lines.push(`- ${code}: ${String(count)} — ${explanation}`);
    }
  };

  add(
    "subject_unavailable",
    result.causes.subjectUnavailable,
    "the requested entity or its required parent disappeared during the read",
  );
  add(
    "parent_epic_not_active",
    result.causes.parentEpicNotActive,
    "the parent Epic is paused or archived, so no descendant work is available",
  );
  for (const status of ["draft", "planned", "blocked", "completed", "cancelled"] as const) {
    add(
      `stream_status_${status}`,
      result.causes.streamStatus[status],
      "the Stream itself is not ready or in progress",
    );
  }
  add(
    "stream_dependency_blocked",
    result.causes.streamDependencyBlocked,
    "an unfinished Stream blocker hides the Stream and all of its Tasks",
  );
  for (const status of ["draft", "blocked", "in_review", "done", "cancelled"] as const) {
    add(
      `task_status_${status}`,
      result.causes.taskStatus[status],
      "the Task is not in ready or in_progress",
    );
  }
  add(
    "task_dependency_blocked",
    result.causes.taskDependencyBlocked,
    "an unfinished Task blocker prevents execution",
  );
  add(
    "unknown_executor_task",
    result.causes.taskExecutorUnknown,
    "the persona filter cannot safely classify a Task without executor_kind",
  );
  add(
    "executor_mismatch",
    result.causes.taskExecutorMismatch,
    "executor_kind does not match the requested persona",
  );
  add(
    "unknown_executor_planning",
    result.causes.planningExecutorUnknown,
    "Stream planning has no executor_kind and was not guessed to be either",
  );
  if (result.streamCount === 0 && result.causes.subjectUnavailable === 0) {
    lines.push("- scope_has_no_streams: 1 — the requested scope currently contains no Streams");
  }
  return lines;
};

/** Text-only to keep the permanent MCP tool-list schema compact. */
export const renderNextWork = (subject: NextWorkSubject, result: NextWorkResult): string => {
  const scopeLine = `${subject.key} (${subject.entity}, ${String(result.streamCount)} stream(s))`;
  const causes = renderCauses(result);

  if (result.items.length === 0) {
    return [
      `No available work in ${scopeLine}.`,
      ...(causes.length === 0
        ? ["No task_execution or stream_planning item satisfies the current selection."]
        : ["Reasons:", ...causes]),
    ].join("\n");
  }

  const header = result.truncated
    ? `Showing ${String(result.items.length)} of ${String(result.availableCount)} available work item(s) in ${scopeLine}:`
    : `${String(result.availableCount)} available work item(s) in ${scopeLine} (${String(result.taskExecutionCount)} task_execution, ${String(result.streamPlanningCount)} stream_planning):`;
  return [
    header,
    ...result.items.map(renderItem),
    ...(result.truncated
      ? ["The requested limit truncated this result; increase limit up to 20 for a larger prefix."]
      : []),
    ...(causes.length > 0 ? ["Not offered:", ...causes] : []),
    "For a ready task_execution, start the Task and its ready parent Stream in the same atomic change set; the server does not change parent status implicitly. A stream_planning item needs Tasks created or brought out of draft before execution.",
  ].join("\n");
};

export const getNextWorkTool = defineTool({
  name: "get_next_work",
  title: "Get next work",
  annotations: { readOnlyHint: true },
  input: getNextWorkInput,
  run: async ({ input, scope }) => {
    if (input.key === undefined) {
      if (input.project === undefined) {
        return toolError(
          TOOL_ERROR_CODE.invalidArguments,
          "Provide project for project-wide work, or provide an M-, E-, or S-key.",
        );
      }
      const resolvedProject = await referenceService.resolveProject(scope, input.project);
      if (!resolvedProject.ok) {
        return toolError(
          TOOL_ERROR_CODE.invalidArguments,
          `Project ${input.project} was not found in this workspace.`,
        );
      }
      const subject: NextWorkSubject = {
        entity: "project",
        id: resolvedProject.project.id,
        key: resolvedProject.project.name,
      };
      const result = await nextWorkService.listNextWork(scope, subject, {
        limit: input.limit,
        executor: input.executor,
      });
      return textResult(renderNextWork(subject, result));
    }

    const resolved = await referenceService.resolveEntityByKey(scope, {
      key: input.key,
      project: input.project,
    });
    if (!resolved.ok) {
      return keyLookupError(resolved);
    }

    const reference = resolved.reference;
    if (
      reference.entity !== "milestone" &&
      reference.entity !== "epic" &&
      reference.entity !== "stream"
    ) {
      return toolError(
        TOOL_ERROR_CODE.invalidArguments,
        `${reference.key} is a ${reference.entity}. get_next_work accepts a Milestone, Epic, Stream, or project scope; use get_context to read ${reference.key}.`,
      );
    }

    const subject: NextWorkSubject = {
      entity: reference.entity,
      id: reference.id,
      key: reference.key,
    };
    const result = await nextWorkService.listNextWork(scope, subject, {
      limit: input.limit,
      executor: input.executor,
    });

    return textResult(renderNextWork(subject, result));
  },
});
