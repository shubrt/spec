import { z } from "zod";
import {
  DEFAULT_NEXT_WORK_LIMIT,
  MAX_NEXT_WORK_LIMIT,
  type NextWorkResult,
  type NextWorkSubject,
  nextWorkService,
} from "../../service/nextWork";
import { referenceService } from "../../service/reference";
import { defineTool } from "../defineTool";
import { TOOL_ERROR_CODE, keyLookupError, textResult, toolError } from "../results";

/**
 * The open, unblocked tasks of one stream or one epic, most urgent first.
 *
 * `project` is the key qualifier, for the same reason it exists on `get_context`:
 * keys are unique per project, so a bare key is resolved by asking every project
 * in the workspace and two answers is a refusal rather than a guess.
 *
 * Which statuses count as workable, what "unblocked" means, and why the ordering
 * happens in TypeScript rather than SQL are all decided — and argued — in
 * `service/nextWork.ts`. This file only turns a key into a subject and renders
 * the answer.
 */
const getNextWorkInput = z.strictObject({
  key: z
    .string()
    .min(1)
    .max(64)
    .describe("Key of the stream or epic to pull work from. An epic spans all of its streams."),
  project: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe("Which project the key is in, by name. Needed only if two projects share a key."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_NEXT_WORK_LIMIT)
    .default(DEFAULT_NEXT_WORK_LIMIT)
    .describe("Maximum number of tasks."),
});

/**
 * Rendered as text rather than `structuredContent` on purpose: the plan gives
 * `outputSchema` to `search_context` and `get_context` only, and every byte of a
 * declared output schema is re-sent inside the 12 KB `tools/list` budget on every
 * turn.
 *
 * `blockedCount` is reported even though the blocked tasks themselves are not.
 * An empty answer has two very different causes — nothing left to do, or
 * everything is waiting on something — and a model that cannot tell them apart
 * will either invent work or report the stream finished.
 */
const render = (subject: NextWorkSubject, result: NextWorkResult): string => {
  const scopeLine =
    subject.entity === "epic"
      ? `${subject.key} (epic, ${String(result.streamCount)} stream(s))`
      : `${subject.key} (stream)`;

  if (result.tasks.length === 0) {
    const reason =
      result.blockedCount > 0
        ? `${String(result.blockedCount)} workable task(s) exist but every one of them is blocked by a task that is not done. Read their dependencies with get_context before starting anything.`
        : "No task is ready or in progress. Either the work is finished, or the tasks are still drafts that have not passed their definition-of-done gate.";
    return [`No available work in ${scopeLine}.`, reason].join("\n");
  }

  const lines = result.tasks.map((task) => {
    const priority = task.priority ?? "unprioritised";
    return `- ${task.key} [${task.taskType}, ${task.status}, ${priority}] ${task.title} — in ${task.streamKey}`;
  });

  const footer =
    result.blockedCount > 0
      ? `${String(result.blockedCount)} further workable task(s) are hidden because something still blocks them.`
      : "Nothing else is blocked.";

  return [
    `${String(result.tasks.length)} available task(s) in ${scopeLine}, most urgent first.`,
    ...lines,
    footer,
    "Take one by applying a change set that updates its status to in_progress with expected_revision from get_context.",
  ].join("\n");
};

export const getNextWorkTool = defineTool({
  name: "get_next_work",
  title: "Get next work",
  annotations: { readOnlyHint: true },
  input: getNextWorkInput,
  run: async ({ input, scope }) => {
    const resolved = await referenceService.resolveEntityByKey(scope, {
      key: input.key,
      project: input.project,
    });
    if (!resolved.ok) {
      return keyLookupError(resolved);
    }

    const reference = resolved.reference;
    if (reference.entity === "task") {
      // A task is the answer this tool gives, never the question it takes.
      // Refused rather than quietly reinterpreted as "the stream containing it",
      // because that would answer a question the caller did not ask.
      return toolError(
        TOOL_ERROR_CODE.invalidArguments,
        `${reference.key} is a task. get_next_work takes the stream or epic to pull work from — pass ${reference.key}'s stream, or call get_context on the task itself.`,
      );
    }

    const subject: NextWorkSubject = {
      entity: reference.entity,
      id: reference.id,
      key: reference.key,
    };
    const result = await nextWorkService.listNextWork(scope, subject, { limit: input.limit });

    return textResult(render(subject, result));
  },
});
