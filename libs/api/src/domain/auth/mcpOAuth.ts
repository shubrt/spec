/**
 * Scopes every MCP access token must carry. This exact list is also advertised
 * during discovery and requested again in OAuth error challenges.
 *
 * `openid` prevents scope-less DCR registrations from inheriting Clerk's
 * incompatible default scope set. `user:org:read` enables organization
 * selection and the `org_id` claim used to bind a request to a workspace.
 */
export const MCP_OAUTH_SCOPES = ["openid", "profile", "email", "user:org:read"] as const;
