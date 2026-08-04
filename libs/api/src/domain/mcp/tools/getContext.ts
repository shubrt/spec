import { z } from "zod";
import { defineTool } from "../defineTool";
import { notImplemented } from "../results";

/**
 * Local, temporary input schema. **Replaced by task B16** (`context/bundle.ts`),
 * which owns what the §7 context bundle actually contains and therefore what can
 * be asked for.
 */
const getContextInput = z.strictObject({
  key: z
    .string()
    .min(1)
    .max(64)
    .describe("Entity key as returned by search_context, for example TASK-123."),
  include_bundle: z
    .boolean()
    .default(true)
    .describe(
      "Include the context needed to act on the entity: parent stream purpose, referenced " +
        "requirements, linked acceptance criteria, applicable business rules and edge cases, " +
        "and dependencies. Set false only when the raw document is all that is wanted.",
    ),
});

export const getContextTool = defineTool({
  name: "get_context",
  title: "Get context",
  annotations: { readOnlyHint: true },
  input: getContextInput,
  run: () => notImplemented("get_context"),
});
