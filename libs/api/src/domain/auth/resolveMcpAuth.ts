import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { recordAuthEvent } from "../../_/eventLog";
import { authenticateOAuthToken } from "../../integration/clerk/authenticator";
import { workspaceRepository } from "../repository/workspace";
import { type AuthContext, toAuthInfo } from "./authContext";
import { makeScope } from "./workspaceScope";

/**
 * The three states `POST /mcp` can be in before any JSON-RPC message is read.
 * `api/mcp/route.ts` maps them onto HTTP; this module deliberately returns no
 * `Response`, so the wire shape of a 401 lives in the api layer next to the
 * `.well-known` document it has to point at.
 */
export type McpAuthOutcome =
  | { status: "authenticated"; auth: AuthContext; authInfo: AuthInfo }
  | { status: "invalid_token"; reason: string }
  | { status: "not_configured" };

/**
 * Resolves the OAuth bearer token on an `/mcp` request into an `AuthContext`.
 *
 * Note what is *not* here: no branch produces a 401 for an authenticated user
 * without an organization. That request resolves to a `NoWorkspaceAuthContext`,
 * the handshake and `tools/list` succeed, and `defineTool` refuses every
 * `tools/call` with remediation text. 401 means exactly one thing — "get a new
 * token" — and telling a client that when a new token would be identical puts it
 * in an infinite OAuth loop.
 */
export async function resolveMcpAuth(request: Request): Promise<McpAuthOutcome> {
  const outcome = await authenticateOAuthToken(request);
  if (outcome.status !== "authenticated") {
    recordAuthEvent({ status: outcome.status, principal: "mcp" });
    return outcome;
  }

  const { identity } = outcome;
  const token = { value: identity.token, clientId: identity.clientId, scopes: identity.scopes };

  if (!identity.org) {
    const auth: AuthContext = {
      userId: identity.userId,
      workspaceId: null,
      clerkOrgId: null,
      scope: null,
      principal: "mcp",
    };
    recordAuthEvent({
      status: "authenticated",
      principal: auth.principal,
      clerkUserId: auth.userId,
      workspaceId: null,
    });
    return { status: "authenticated", auth, authInfo: toAuthInfo(auth, token) };
  }

  // Just-in-time: the first request for an organization inserts its workspace
  // row, later ones refresh name and slug from the token, so a rename in Clerk
  // propagates without a webhook. `name` is NOT NULL in the schema, so it falls
  // back through slug to the org id rather than inventing a placeholder.
  const workspace = await workspaceRepository.ensure({
    clerkOrgId: identity.org.id,
    name: identity.org.name ?? identity.org.slug ?? identity.org.id,
    slug: identity.org.slug,
  });

  const auth: AuthContext = {
    userId: identity.userId,
    workspaceId: workspace.id,
    clerkOrgId: identity.org.id,
    // One of the resolver calls makeScope's doc comment allows. The uuid comes from
    // the row above, never from the token and never from tool input.
    scope: makeScope(workspace.id),
    principal: "mcp",
  };
  recordAuthEvent({
    status: "authenticated",
    principal: auth.principal,
    clerkUserId: auth.userId,
    workspaceId: auth.workspaceId,
  });
  return { status: "authenticated", auth, authInfo: toAuthInfo(auth, token) };
}
