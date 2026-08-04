import { defineTool } from "../defineTool";
import { notImplemented } from "../results";
import { changeSetInput } from "./validateChangeSet";

/**
 * The same input as `validate_change_set` — a dry run that accepted something the
 * real call would reject is worse than no dry run at all. `confirm` is not
 * declared here: `defineTool` adds it to every `destructiveHint` tool, so it
 * cannot be forgotten and cannot be spelled differently between write tools.
 *
 * **Replaced by task B14** (`service/changeSet.ts`), which owns the pipeline both
 * tools run.
 */
export const applyChangeSetTool = defineTool({
  name: "apply_change_set",
  title: "Apply change set",
  annotations: { destructiveHint: true },
  input: changeSetInput,
  run: () => notImplemented("apply_change_set"),
});
