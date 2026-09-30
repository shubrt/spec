import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { DocumentIssue } from "../schema/rules";

/**
 * The machine-readable codes a `tools/call` can fail with at this layer.
 *
 * These are *tool* errors — `isError: true` inside a 200 response — not JSON-RPC
 * errors. The three boundaries spec renders an error across (JSON-RPC error,
 * `isError` tool result, HTTP JSON body) stay deliberately distinct, so nothing
 * here leaks into the other two.
 *
 * The last five mirror `service/changeSet.ts`'s outcome codes and the two ways a
 * key lookup can fail, so a model sees the same word for the same condition
 * whichever tool it called.
 */
export const TOOL_ERROR_CODE = {
  /** Authenticated, but the token resolved to no workspace. */
  noWorkspace: "no_workspace",
  /** A destructive change-set operation arrived without `confirm: true`. */
  destructiveRequiresConfirm: "destructive_requires_confirm",
  /** The arguments parsed but violate a rule JSON Schema cannot express. */
  invalidArguments: "invalid_arguments",
  /** The change set cannot be applied. Carries `DocumentIssue`s with rule ids. */
  invalidChangeSet: "invalid_change_set",
  /** Someone else wrote the entity first. Carries the current document. */
  revisionConflict: "revision_conflict",
  /** Nothing in this workspace answers to that key or that project. */
  notFound: "not_found",
  /** Two projects of this workspace answer to that key. */
  ambiguousKey: "ambiguous_key",
} as const;

export type ToolErrorCode = (typeof TOOL_ERROR_CODE)[keyof typeof TOOL_ERROR_CODE];

/**
 * What a model is told to do when its token carries no organization.
 *
 * This text is the entire remediation channel for that state: the handshake
 * succeeded, so the client shows a healthy connection, and this is the only
 * place the user ever learns why nothing works. It has to name the action
 * ("create or join an organization"), and the follow-up ("reconnect"), because
 * a new token is required — refreshing the page will not add an `org_id`.
 */
export const NO_WORKSPACE_REMEDIATION =
  "Your access token is valid, but it is not scoped to an organization, so there is no " +
  "spec workspace to read or write. Tell the user, in these terms: create or join an " +
  "organization in the spec web app, then reconnect this MCP server so a new token is " +
  "issued that carries the organization. Until then no spec tool can return data. Do not " +
  "retry — every retry with this token fails the same way.";

/**
 * A failed tool call.
 *
 * The code is a prefix of the text rather than a field of `structuredContent`,
 * and that is a measured constraint, not a style choice: the MCP SDK's own
 * `Client.callTool` validates `structuredContent` against the tool's declared
 * `outputSchema` **even when `isError` is true** (client/index.js — the
 * `isError` short-circuit exists on the server side only). A structured error
 * body would therefore throw inside any client that had listed the tool's
 * output schema. The text is also what the model actually reads.
 */
export function toolError(code: ToolErrorCode, message: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: `${code}: ${message}` }],
  };
}

/**
 * A successful tool call whose result the tool declares an `outputSchema` for.
 *
 * Both halves are supplied on purpose. `structuredContent` is what a client that
 * listed the output schema reads and validates against it — the SDK *refuses* a
 * result that has an output schema and no structured content
 * (`server/mcp.js`, `validateToolOutput`). The `content` text is what a model
 * without structured-output support reads, and the SDK never fills it in, so
 * omitting it would make the result invisible to exactly those clients.
 */
export function structuredResult(
  text: string,
  structuredContent: Record<string, unknown>,
): CallToolResult {
  return {
    content: [{ type: "text", text }],
    structuredContent,
  };
}

/** A successful tool call whose result is prose or JSON the model reads directly. */
export function textResult(text: string): CallToolResult {
  return {
    content: [{ type: "text", text }],
  };
}

/**
 * The one rendering of a failed key lookup, shared by `get_context` and
 * `get_next_work`.
 *
 * Both tools take a key and an optional project, so both can fail the same four
 * ways, and each message has to be actionable on its own — a model does not get to
 * ask a follow-up question. `ambiguous` is the important one: it names the projects
 * that answered and the argument that resolves it, because a workspace with two
 * projects is otherwise unable to address `E-1` at all.
 */
export function keyLookupError(resolution: {
  reason: "not_a_key" | "unknown_project" | "not_found" | "ambiguous";
  key?: string;
  ref?: string;
  projectNames?: readonly string[];
}): CallToolResult {
  switch (resolution.reason) {
    case "not_a_key": {
      return toolError(
        TOOL_ERROR_CODE.invalidArguments,
        `${resolution.key ?? ""} is not a versioned entity key. Keys look like E-1, S-12, T-45, M-2 or R-7, and search_context returns them. Do not guess one.`,
      );
    }
    case "unknown_project": {
      return toolError(
        TOOL_ERROR_CODE.notFound,
        `No project of this workspace is called ${resolution.ref ?? ""}. Omit project to search all of them.`,
      );
    }
    case "not_found": {
      return toolError(
        TOOL_ERROR_CODE.notFound,
        `Nothing in this workspace has the key ${resolution.key ?? ""}. Find it with search_context rather than trying neighbouring numbers.`,
      );
    }
    case "ambiguous": {
      const names = (resolution.projectNames ?? []).join(", ");
      return toolError(
        TOOL_ERROR_CODE.ambiguousKey,
        `${resolution.key ?? ""} exists in more than one project of this workspace, so it does not name one entity — keys are unique per project, not per workspace. Call this tool again with project set to one of: ${names}.`,
      );
    }
  }
}

/**
 * `DocumentIssue`s rendered as the one feedback channel the model acts on.
 *
 * One line per issue, path first, because the path is what tells an agent which
 * of fifty operations to fix. `issue.message` already carries the rule id in
 * brackets when there is a rule (`ruleText`); a shape failure has no rule and is
 * printed without one rather than with an invented id.
 */
export function formatIssues(issues: readonly DocumentIssue[]): string {
  return issues
    .map((issue) => `- ${issue.path.length === 0 ? "(change set)" : issue.path}: ${issue.message}`)
    .join("\n");
}
