import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { WorkspaceScope } from "./workspaceScope";

/** Which door the request came through. Not a permission — zpecs has no role gating. */
export type Principal = "mcp" | "session";

/**
 * An authenticated caller whose token resolved to a workspace. Tool bodies and
 * repository calls only ever see this variant, so `scope` is never nullable at
 * the point of use.
 */
export type WorkspaceAuthContext = {
  userId: string;
  workspaceId: string;
  clerkOrgId: string;
  scope: WorkspaceScope;
  principal: Principal;
};

/**
 * An authenticated caller with all required scopes but no selected organization,
 * so the token carries no `org_id`.
 *
 * This state is deliberately *not* an error at the transport level. `initialize`
 * and `tools/list` succeed; every `tools/call` is intercepted in `defineTool`
 * and answers `isError` with remediation text. Answering 401 here would tell the
 * MCP client its token is bad, and it would restart the OAuth flow forever —
 * with the same result, because a second token would carry no `org_id` either.
 */
export type NoWorkspaceAuthContext = {
  userId: string;
  workspaceId: null;
  clerkOrgId: null;
  scope: null;
  principal: Principal;
};

export type AuthContext = WorkspaceAuthContext | NoWorkspaceAuthContext;

/** The type guard that turns "has a workspace" into a compile-time fact. */
export function hasWorkspace(auth: AuthContext): auth is WorkspaceAuthContext {
  return auth.scope !== null;
}

/**
 * The key zpecs's `AuthContext` travels under inside the MCP SDK's `AuthInfo`.
 *
 * The SDK's `AuthInfo` is the only channel from an HTTP request into a tool
 * handler: `transport.handleRequest(request, { authInfo })` puts it on every
 * `RequestHandlerExtra`. `extra` is the SDK's sanctioned place for
 * application-specific data. Namespaced so a future SDK field cannot collide.
 */
const AUTH_CONTEXT_KEY = "zpecs/authContext";

/** Packs an `AuthContext` into the SDK's `AuthInfo`, ready for `handleRequest`. */
export function toAuthInfo(
  auth: AuthContext,
  token: { value: string; clientId: string; scopes: string[] },
): AuthInfo {
  return {
    token: token.value,
    clientId: token.clientId,
    scopes: token.scopes,
    extra: { [AUTH_CONTEXT_KEY]: auth },
  };
}

/**
 * Unpacks the `AuthContext` a tool handler was invoked with.
 *
 * Returns null rather than throwing when it is absent: an MCP request can reach
 * a handler with no `authInfo` at all, and `defineTool` turns that into a closed
 * `isError` result. There is no code path where a missing context means "allow".
 */
export function readAuthContext(authInfo: AuthInfo | undefined): AuthContext | null {
  const candidate = authInfo?.extra?.[AUTH_CONTEXT_KEY];
  if (typeof candidate !== "object" || candidate === null) return null;
  return candidate as AuthContext;
}
