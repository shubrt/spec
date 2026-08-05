import { changeSetSchema } from "../../changeSet/schema";
import { defineTool } from "../defineTool";
import { runChangeSetTool } from "./validateChangeSet";

/**
 * The write path. The *only* write path — nothing else in zpecs mutates these
 * tables.
 *
 * Identical input and identical pipeline to `validate_change_set`, down to
 * sharing `runChangeSetTool`, because the two differ by exactly one thing: this
 * one commits. A dry run built from a second copy of this code would eventually
 * accept something the real call rejects, and then `validate_change_set` — the
 * designated feedback channel for every rule JSON Schema cannot express — would
 * be lying to the model.
 *
 * ## `destructiveHint` is an annotation here and nothing more
 *
 * It tells an MCP client to ask its user before calling. It arms no server-side
 * gate: `confirm: true` is required **per destructive operation**, inside
 * `service/changeSet.ts`, where the server knows whether this particular change
 * set deletes anything. A per-call gate on this tool would demand `confirm` even
 * for a change set that only creates, which teaches an agent to send the flag
 * reflexively and destroys the signal the gate exists to carry.
 */
export const applyChangeSetTool = defineTool({
  name: "apply_change_set",
  title: "Apply change set",
  annotations: { destructiveHint: true },
  input: changeSetSchema,
  run: async ({ input, auth }) => await runChangeSetTool("apply", auth, input),
});
