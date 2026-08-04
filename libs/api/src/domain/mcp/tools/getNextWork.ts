import { z } from "zod";
import { defineTool } from "../defineTool";
import { notImplemented } from "../results";

/**
 * Local, temporary input schema. **Replaced by task B17** together with the body,
 * once the task repository (B11) defines how work is ordered.
 */
const getNextWorkInput = z.strictObject({
  key: z
    .string()
    .min(1)
    .max(64)
    .describe("Key of the stream or epic to pull work from. An epic spans all of its streams."),
  limit: z.number().int().min(1).max(20).default(5).describe("Maximum number of tasks."),
});

export const getNextWorkTool = defineTool({
  name: "get_next_work",
  title: "Get next work",
  annotations: { readOnlyHint: true },
  input: getNextWorkInput,
  run: () => notImplemented("get_next_work"),
});
