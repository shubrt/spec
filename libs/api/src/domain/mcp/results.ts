import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/**
 * The machine-readable codes a `tools/call` can fail with at this layer.
 *
 * These are *tool* errors — `isError: true` inside a 200 response — not JSON-RPC
 * errors. The three boundaries zpecs renders an error across (JSON-RPC error,
 * `isError` tool result, HTTP JSON body) stay deliberately distinct, so nothing
 * here leaks into the other two.
 */
export const TOOL_ERROR_CODE = {
  /** Authenticated, but the token resolved to no workspace. */
  noWorkspace: "no_workspace",
  /** A `destructiveHint` tool was called without `confirm: true`. */
  destructiveRequiresConfirm: "destructive_requires_confirm",
  /** The tool exists with its final name, schema and annotations; the body does not. */
  notImplemented: "not_implemented",
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
  "zpecs workspace to read or write. Tell the user, in these terms: create or join an " +
  "organization in the zpecs web app, then reconnect this MCP server so a new token is " +
  "issued that carries the organization. Until then no zpecs tool can return data. Do not " +
  "retry — every retry with this token fails the same way.";

/** What a model is told when it called a destructive tool without confirmation. */
export const CONFIRM_REMEDIATION =
  "This tool writes. Nothing was changed. Show the user exactly what you are about to " +
  "change, get their explicit approval, then call this tool again with `confirm: true` and " +
  "otherwise identical arguments.";

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

// There is deliberately no success builder here yet. Every tool body returns
// `notImplemented`, so one would be dead code — and the tool that gets a real
// result first (search_context, B15) also has the only `outputSchema`, which
// makes `structuredContent` mandatory rather than optional. Whoever writes that
// body writes the builder its contract actually needs.

/**
 * The body every tool ships with until workstream B fills it in. Names the tool
 * so a model that receives one can say which capability is missing, and states
 * the shape is final so it does not try a different tool name.
 */
export function notImplemented(toolName: string): CallToolResult {
  return toolError(
    TOOL_ERROR_CODE.notImplemented,
    `The tool \`${toolName}\` is registered with its final name, input schema and ` +
      "annotations, but its implementation is not deployed yet. Report this to the user as a " +
      "server-side gap and do not attempt a workaround.",
  );
}
