import { z } from "zod";
import { ENTITY_TYPE } from "../../enums";
import { defineTool } from "../defineTool";
import { notImplemented } from "../results";

/**
 * Local, temporary input schema. **Replaced by task B15** (the `search_context`
 * repository and service), which owns the real query options. It is defined here
 * rather than imported from `domain/schema/` on purpose: the shared content
 * schemas describe *documents*, not tool arguments, and a tool's arguments must
 * stay small enough to read in a `tools/list` payload.
 */
const searchContextInput = z.strictObject({
  query: z
    .string()
    .min(1)
    .max(200)
    .describe("Words to search for in titles and document text. Not a boolean query language."),
  entity: z
    .enum(ENTITY_TYPE)
    .optional()
    .describe("Restrict to one entity kind. Omit to search epics, streams and tasks together."),
  project: z
    .string()
    .optional()
    .describe("Restrict to one project by key or slug. Omit to search the whole workspace."),
  limit: z.number().int().min(1).max(50).default(20).describe("Maximum number of hits."),
});

/**
 * The compact hit shape from the plan's tool table. This is the one tool the plan
 * specifies `structuredContent` for, which is why it is the one tool here with an
 * `outputSchema` — the others return text until workstream B gives them a real
 * result shape.
 */
const searchContextOutput = z.strictObject({
  hits: z.array(
    z.strictObject({
      key: z.string(),
      title: z.string(),
      type: z.string().describe("Entity kind, plus the stream type for a stream."),
      status: z.string(),
      snippet: z.string().describe("Matching text, trimmed. Not the whole document."),
    }),
  ),
});

export const searchContextTool = defineTool({
  name: "search_context",
  title: "Search context",
  annotations: { readOnlyHint: true },
  input: searchContextInput,
  output: searchContextOutput,
  run: () => notImplemented("search_context"),
});
