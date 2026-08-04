import { authenticateSession } from "../../integration/clerk/authenticator";
import { workspaceRepository } from "../repository/workspace";
import type { AuthContext } from "./authContext";
import { makeScope } from "./workspaceScope";

/**
 * The web UI's states. Same three as `/mcp`, minus the OAuth challenge: a
 * browser session that is signed out gets sent to Clerk's sign-in flow by the
 * frontend, not by a `WWW-Authenticate` header.
 */
export type SessionAuthOutcome =
  | { status: "authenticated"; auth: AuthContext }
  | { status: "signed_out"; reason: string }
  | { status: "not_configured" };

/**
 * Resolves a Clerk **session** token into an `AuthContext` for the authenticated
 * REST subtree (`api/plugin/authScope.ts`).
 *
 * The session auth object exposes `orgId` and `orgSlug` directly, so unlike the
 * MCP path this needs no claim archaeology — nothing here is unverified.
 */
export async function resolveSessionAuth(request: Request): Promise<SessionAuthOutcome> {
  const outcome = await authenticateSession(request);
  if (outcome.status === "not_configured") return { status: "not_configured" };
  if (outcome.status === "invalid_token") {
    return { status: "signed_out", reason: outcome.reason };
  }

  const { identity } = outcome;
  if (!identity.org) {
    return {
      status: "authenticated",
      auth: {
        userId: identity.userId,
        workspaceId: null,
        clerkOrgId: null,
        scope: null,
        principal: "session",
      },
    };
  }

  // The same JIT upsert the MCP path uses, so whichever door a user arrives at
  // first creates the workspace. A session token carries no organization name,
  // so the row falls back to the slug and the MCP path refreshes it later.
  const workspace = await workspaceRepository.ensure({
    clerkOrgId: identity.org.id,
    name: identity.org.name ?? identity.org.slug ?? identity.org.id,
    slug: identity.org.slug,
  });

  return {
    status: "authenticated",
    auth: {
      userId: identity.userId,
      workspaceId: workspace.id,
      clerkOrgId: identity.org.id,
      // The second of the two resolver call sites makeScope's doc comment allows.
      scope: makeScope(workspace.id),
      principal: "session",
    },
  };
}
