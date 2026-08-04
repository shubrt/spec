import { z } from "zod";
import { ENTITY_TYPE, STREAM_TYPE } from "../../enums";
import { defineTool } from "../defineTool";
import { notImplemented } from "../results";

/**
 * Local, temporary input schema. **Replaced by task B10** (`schema/jsonSchema.ts`),
 * which owns the schema registry this tool reads from.
 */
const getEntitySchemaInput = z.strictObject({
  entity: z.enum(ENTITY_TYPE).describe("Which entity kind's document schema to return."),
  // A cross-field rule: required when `entity` is "stream", meaningless otherwise.
  // `z.toJSONSchema()` silently drops `.refine()`, so the rule is carried as the
  // field's own description — the only form a model ever sees — and enforced by
  // the tool body. Global constraints require exactly this pairing.
  stream_type: z
    .enum(STREAM_TYPE)
    .optional()
    .meta({
      description:
        "Required when entity is 'stream': each stream type has its own content schema. " +
        "Must be omitted for 'epic' and 'task'.",
    }),
});

export const getEntitySchemaTool = defineTool({
  name: "get_entity_schema",
  title: "Get entity schema",
  annotations: { readOnlyHint: true },
  input: getEntitySchemaInput,
  run: () => notImplemented("get_entity_schema"),
});
