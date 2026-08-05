import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { changeSetSchema } from "../../changeSet/schema";
import type { ChangeSetMode, ChangeSetOutcome } from "../../service/changeSet";
import { runChangeSet } from "../../service/changeSet";
import type { WorkspaceAuthContext } from "../../auth/authContext";
import { TOOL_ERROR_CODE, formatIssues, textResult, toolError } from "../results";
import { defineTool } from "../defineTool";

/**
 * The dry run. Same input and domain pipeline as `apply_change_set`, with a
 * rollback-only transaction. The one deliberate policy exception is consent:
 * validate may simulate an unconfirmed destructive operation because it cannot
 * persist it; apply refuses that operation until its own `confirm: true` is
 * present. That lets the user inspect a fully validated proposal before approval.
 *
 * `changeSetSchema` is the real schema from `changeSet/schema.ts`; the local
 * stand-in agent δ declared here is gone. Note the consequence: an input the schema
 * itself rejects now fails at the MCP boundary as a JSON-RPC -32602, because
 * `defineTool` hands the schema to `registerTool` and the SDK parses before any body
 * runs. `runChangeSet`'s own `invalid_change_set` issues — the ones carrying rule ids
 * — are what an input that *parses* but breaks a domain rule comes back with, which
 * is the overwhelming majority of them: `data` is an opaque record at this layer, so
 * every document error is a domain error.
 */

/**
 * Runs one mode and renders the outcome. Both tools call exactly this.
 *
 * The change set is passed through unparsed by this layer — `runChangeSet` owns the
 * parse, so there is exactly one place a change set is validated and an
 * unvalidated object cannot slip past. `auth` comes from the `AuthContext`, never
 * from the input: there is no `actor` and no `workspace` field to forge.
 */
export async function runChangeSetTool(
  mode: ChangeSetMode,
  auth: WorkspaceAuthContext,
  input: unknown,
): Promise<CallToolResult> {
  return renderOutcome(mode, await runChangeSet(mode, { auth, input }));
}

function renderOutcome(mode: ChangeSetMode, outcome: ChangeSetOutcome): CallToolResult {
  if (!outcome.ok) {
    return renderRefusal(outcome);
  }
  const header =
    mode === "validate"
      ? `Valid. ${String(outcome.applied.length)} operation(s) would be applied, and nothing was written. Created keys below are provisional: a concurrent writer can advance the counters, so the apply_change_set result is authoritative.`
      : `Applied ${String(outcome.applied.length)} operation(s).`;
  const lines = outcome.applied.map((applied) => {
    const parts = [`operations[${String(applied.index)}] ${applied.operation}`];
    if (applied.entity !== null) {
      parts.push(applied.entity);
    }
    if (applied.key !== null) {
      parts.push(applied.key);
    }
    if (applied.ref !== null) {
      parts.push(`(${applied.ref})`);
    }
    // A validate run creates rows only inside a transaction that is deliberately
    // rolled back. Its UUIDs never become public entity ids and must not be
    // presented as predictions; apply's committed ids are authoritative.
    if (mode === "apply" && applied.id !== null) {
      parts.push(`id ${applied.id}`);
    }
    if (applied.revision !== null) {
      parts.push(`revision ${String(applied.revision)}`);
    }
    return `- ${parts.join(" ")}`;
  });
  const footer =
    mode === "validate"
      ? "To write it, call apply_change_set with this proposal; add confirm: true to every archive, delete or move the user explicitly approves. Then use apply's committed ids, keys and revisions."
      : "Report the ids and keys to the user. Use the revisions above as expected_revision on your next update.";
  return textResult([header, ...lines, footer].join("\n"));
}

function renderRefusal(outcome: Extract<ChangeSetOutcome, { ok: false }>): CallToolResult {
  switch (outcome.code) {
    case "invalid_change_set": {
      return toolError(
        TOOL_ERROR_CODE.invalidChangeSet,
        [
          "Nothing was written. Fix the change set itself — never work around a rule, and if a report shows the user's intent was ambiguous, ask them instead of choosing.",
          formatIssues(outcome.issues),
        ].join("\n"),
      );
    }
    case "destructive_requires_confirm": {
      return toolError(TOOL_ERROR_CODE.destructiveRequiresConfirm, outcome.message);
    }
    case "revision_conflict": {
      return toolError(
        TOOL_ERROR_CODE.revisionConflict,
        [
          outcome.message,
          `The current document of ${outcome.current.key}, at revision ${String(outcome.current.revision)}, follows — merge into this rather than calling get_context again.`,
          JSON.stringify(outcome.current.document),
        ].join("\n"),
      );
    }
  }
}

export const validateChangeSetTool = defineTool({
  name: "validate_change_set",
  title: "Validate change set",
  annotations: { readOnlyHint: true },
  input: changeSetSchema,
  run: async ({ input, auth }) => await runChangeSetTool("validate", auth, input),
});
