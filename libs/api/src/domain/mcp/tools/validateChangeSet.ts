import { z } from "zod";
import { ENTITY_TYPE, RELATIONSHIP_TYPE } from "../../enums";
import { defineTool } from "../defineTool";
import { notImplemented } from "../results";

/**
 * Local, temporary input schema. **Replaced by task B13** (`changeSet/schema.ts`),
 * which owns the real change-set schema including per-entity `data` validation.
 *
 * `data` is deliberately opaque here: the whole point of `get_entity_schema` and
 * the `zpecs://schema/` resources is that document shapes are fetched on demand
 * instead of inlined into every `tools/list` payload. Keeping `data` flat and
 * unvalidated at this layer is what makes that possible; B13/B14 validate it
 * against the entity schema on the server.
 *
 * Exported because `apply_change_set` must accept the *identical* input — the two
 * tools are one code path with a write at the end, and two copies of this shape
 * would be two shapes within a release.
 */
export const changeSetInput = z.strictObject({
  reason: z.string().min(1).max(500).describe("Why this change set exists, in the user's terms."),
  operations: z
    .array(
      z.strictObject({
        operation: z.enum(["create", "update", "link"]),
        entity: z.enum(ENTITY_TYPE).optional().describe("create, update."),
        key: z
          .string()
          .optional()
          .describe("update: the entity's key. create: an optional alias for later operations."),
        based_on_revision: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("update: the revision get_context returned. Stale values are rejected."),
        data: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("create, update: document fields. Get the shape from get_entity_schema."),
        source: z.string().optional().describe("link: key or alias."),
        target: z.string().optional().describe("link: key or alias."),
        relationship: z.enum(RELATIONSHIP_TYPE).optional().describe("link."),
      }),
    )
    .min(1)
    .max(50)
    // Terse on purpose: this schema is serialised into `tools/list` twice, once
    // per change-set tool, so every character is paid for twice on every listing.
    // The full form of each operation lives in zpecs://guide/change-sets, which
    // costs nothing until a model reads it.
    .describe("Applied in order, atomically. One intent per set. See zpecs://guide/change-sets."),
});

export const validateChangeSetTool = defineTool({
  name: "validate_change_set",
  title: "Validate change set",
  annotations: { readOnlyHint: true },
  input: changeSetInput,
  run: () => notImplemented("validate_change_set"),
});
