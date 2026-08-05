import { getClerkClient } from "./client";

/**
 * The organization a token is scoped to, reduced to the three fields
 * `workspaceRepository.ensure` needs. `null` name/slug are normal — only the id
 * is load-bearing.
 */
export type ClerkOrgClaims = {
  id: string;
  name: string | null;
  slug: string | null;
};

/** What a verified OAuth access token tells us. */
export type ClerkTokenIdentity = {
  token: string;
  userId: string;
  clientId: string;
  scopes: string[];
  /** `null` when the token is not scoped to an organization — see `readOrgClaims`. */
  org: ClerkOrgClaims | null;
};

/** What a verified Clerk session cookie/token tells us (the web app's path). */
export type ClerkSessionIdentity = {
  userId: string;
  org: ClerkOrgClaims | null;
};

/**
 * Three outcomes, deliberately not two: "the token is bad" and "this server has
 * no Clerk credentials" must produce different HTTP statuses. Answering 401 for
 * a server-side misconfiguration would send an MCP client into an OAuth flow
 * that cannot possibly succeed.
 */
export type AuthenticationOutcome<TIdentity> =
  | { status: "authenticated"; identity: TIdentity }
  | { status: "invalid_token"; reason: string }
  | { status: "not_configured" };

/**
 * ── THE LIVE-VERIFIED TOKEN DECISION IN THIS FILE ─────────────────────────────
 *
 * Where `org_id` comes from. The canonical Clerk instance's DCR consent flow was
 * exercised with a real Claude Code client: it issued a JWT access token carrying
 * `org_id`, and that direct claim produced the expected JIT workspace. The token
 * was inspected locally for claim presence and was never printed or persisted.
 * If a future Clerk configuration resolves no workspace for an organization user,
 * this function remains the first place to look; correct the one extraction path
 * here rather than spreading token-shape knowledge through the domain layer.
 *
 * What is known:
 *
 *  - `@clerk/backend@3.15.0` types the authenticated `oauth_token` auth object
 *    as `{ id, subject, scopes, userId, clientId, tokenType, isAuthenticated,
 *    getToken, has, debug }` — there is no `orgId` and no `claims` on it. (Only
 *    the `api_key` auth object carries `orgId`.) So the SDK's auth object is
 *    not a candidate today, whatever a later version may add.
 *  - Clerk's own documentation on OAuth + Organizations states that once the
 *    `user:org:read` scope is granted, "an `org_id` claim is included in the
 *    access and ID tokens, and is accessible via user info and token
 *    introspection endpoints". That documented provider contract now also
 *    matches the live observation above.
 *
 * The three candidate read paths the plan names, and why this one:
 *
 *  1. *From the SDK auth object* — ruled out by the typing above.
 *  2. *From the claims of the access token Clerk has already verified* — what
 *     this function does. No extra network call, no extra latency on every
 *     request. Requires the access token to be a JWT.
 *  3. *From the userinfo endpoint* — one HTTP round trip per request (or a
 *     cache to build), but it is the documented source and it also returns
 *     `org_name` and `org_slug`, which would fill the workspace row outright.
 *     **This remains the fallback if path 2 ever comes up empty**. Opaque
 *     access tokens cannot satisfy the strict local audience check below;
 *     supporting them would require an introspection/userinfo path that keeps
 *     the same audience guarantee before resolving organization claims.
 *
 * Decoding without re-verifying is safe *here specifically*: the caller only
 * ever passes the token string that `clerkClient.authenticateRequest` just
 * verified the signature of. Do not call this with an unverified token.
 */
export function readOrgClaims(verifiedAccessToken: string): ClerkOrgClaims | null {
  const claims = decodeJwtPayload(verifiedAccessToken);
  if (!claims) return null;

  const id = claims["org_id"];
  if (typeof id !== "string" || id === "") return null;

  const name = claims["org_name"];
  const slug = claims["org_slug"];
  return {
    id,
    name: typeof name === "string" && name !== "" ? name : null,
    slug: typeof slug === "string" && slug !== "" ? slug : null,
  };
}

/**
 * Reads the payload segment of a JWT. Returns null for anything that is not a
 * three-segment JWT with a JSON object payload. Callers decide whether that
 * means an invalid audience-bound OAuth token or an absent optional claim;
 * malformed input must never turn either path into a 500.
 *
 * This performs **no** signature check by design; see `readOrgClaims`.
 */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const segments = token.split(".");
  if (segments.length !== 3) return null;
  const payload = segments[1];
  if (!payload) return null;

  try {
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const bytes = Uint8Array.from(
      atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")),
      (character) => character.charCodeAt(0),
    );
    const decoded: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) return null;
    return decoded as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Clerk checks a configured audience when an `aud` claim is present, but its
 * verifier intentionally tolerates tokens without that claim for other Clerk
 * token types. MCP access tokens are audience-bound, so the already-verified
 * JWT must also carry this resource explicitly.
 */
function hasExpectedAudience(verifiedAccessToken: string, expectedAudience: string): boolean {
  const audience = decodeJwtPayload(verifiedAccessToken)?.["aud"];
  if (typeof audience === "string") return audience === expectedAudience;
  return (
    Array.isArray(audience) &&
    audience.every((entry) => typeof entry === "string") &&
    audience.includes(expectedAudience)
  );
}

/**
 * The single OAuth authentication boundary.
 *
 * `acceptsToken: "oauth_token"` is what makes a Clerk *session* cookie fail
 * here: `/mcp` is reachable only with a token issued through the OAuth flow.
 * `audience` binds that token to the configured public MCP resource.
 */
export async function authenticateOAuthToken(
  request: Request,
  expectedAudience: string,
): Promise<AuthenticationOutcome<ClerkTokenIdentity>> {
  const clerk = getClerkClient();
  if (!clerk) return { status: "not_configured" };

  const requestState = await clerk.authenticateRequest(request, {
    acceptsToken: "oauth_token",
    audience: expectedAudience,
  });
  if (!requestState.isAuthenticated) {
    return { status: "invalid_token", reason: requestState.reason };
  }
  if (!hasExpectedAudience(requestState.token, expectedAudience)) {
    return { status: "invalid_token", reason: "token_audience_mismatch" };
  }

  const auth = requestState.toAuth();
  return {
    status: "authenticated",
    identity: {
      token: requestState.token,
      userId: auth.userId,
      clientId: auth.clientId,
      scopes: auth.scopes,
      org: readOrgClaims(requestState.token),
    },
  };
}

/**
 * The web app's path. A Clerk session token carries `orgId` and `orgSlug` on the
 * auth object itself, so unlike `authenticateOAuthToken` this needs no claim
 * archaeology and no `readOrgClaims`.
 *
 * `org_name` is not on the session auth object; the workspace row's `name`
 * falls back in `resolveSessionAuth`, and the MCP path refreshes it on the next
 * request anyway (`workspaceRepository.ensure` upserts name and slug).
 */
export async function authenticateSession(
  request: Request,
): Promise<AuthenticationOutcome<ClerkSessionIdentity>> {
  const clerk = getClerkClient();
  if (!clerk) return { status: "not_configured" };

  const requestState = await clerk.authenticateRequest(request, { acceptsToken: "session_token" });
  if (!requestState.isAuthenticated) {
    return { status: "invalid_token", reason: requestState.reason };
  }

  const auth = requestState.toAuth();
  return {
    status: "authenticated",
    identity: {
      userId: auth.userId,
      org: auth.orgId ? { id: auth.orgId, name: null, slug: auth.orgSlug ?? null } : null,
    },
  };
}
