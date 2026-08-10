import { z } from "zod";
import { STREAM_TYPE, VERSIONED_ENTITY_TYPE, type StreamType } from "../../enums";
import type { DocumentSchemaTarget } from "../../schema/document";
import { documentJsonSchema } from "../../schema/jsonSchema";
import { resolveDocumentSchemaTarget } from "../../schema/target";
import { defineTool } from "../defineTool";
import { TOOL_ERROR_CODE, textResult, toolError } from "../results";

/**
 * The exact JSON Schema a document must satisfy, generated from the same Zod
 * schemas `parseDocument` validates with — so this is not documentation *about* the
 * rules, it is the rules.
 */
const getEntitySchemaInput = z.strictObject({
  entity: z.enum(VERSIONED_ENTITY_TYPE),
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
        "Omit for epic, task, rule, and milestone.",
    }),
});

export const getEntitySchemaTool = defineTool({
  name: "get_entity_schema",
  title: "Get entity schema",
  annotations: { readOnlyHint: true },
  input: getEntitySchemaInput,
  run: ({ input }) => {
    // The two branches are separated by `entity` rather than sharing one ternary
    // so that each one carries its own narrowing: inside the stream branch
    // `stream_type` is known present, and outside it `entity` is known not to be
    // "stream" — which is what makes `DocumentSchemaTarget` assignable without a
    // cast. A single expression cannot express that, because the guard that
    // rules out the impossible pairs returns rather than narrows.
    if (input.entity === "stream") {
      if (input.stream_type === undefined) {
        return toolError(
          TOOL_ERROR_CODE.invalidArguments,
          `Each stream type has its own content schema, so stream_type is required for a stream. One of: ${STREAM_TYPE.join(", ")}.`,
        );
      }
      return renderSchema(
        resolveDocumentSchemaTarget({ entity: "stream", streamType: input.stream_type }),
        input.stream_type,
      );
    }

    if (input.stream_type !== undefined) {
      return toolError(
        TOOL_ERROR_CODE.invalidArguments,
        `stream_type only applies to a stream, and you asked for ${input.entity}. Send the same call without it.`,
      );
    }

    return renderSchema(resolveDocumentSchemaTarget({ entity: input.entity }), undefined);
  },
});

/**
 * The agent tier, always.
 *
 * The stored tier advertises `meta.id`, `meta.key` and `meta.revision` as writable
 * fields, which is exactly the forgery the two-tier split blocks — handing an agent
 * that schema would teach it to attempt it.
 */
function renderSchema(target: DocumentSchemaTarget, streamType: StreamType | undefined) {
  const schema = documentJsonSchema(target);
  const note = `Schema target: ${target}${streamType === undefined ? "" : ` (${streamType})`}.`;

  return textResult(
    [
      note,
      "This schema describes the composed agent document. In create/update data omit entity, schema_version and links: create derives them from operation.entity and operation.parent, while update accepts only the sections to replace.",
      "Cross-field rules that JSON Schema cannot express are in the field descriptions, and validate_change_set is what enforces them.",
      JSON.stringify(schema),
    ].join("\n"),
  );
}
