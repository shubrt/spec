# Canonical Clerk instance — setup and live verification

The Clerk tenant configured in `apps/web/.env` is zpecs' canonical
authorization server for both Claude Code and OpenAI Codex. zpecs does not run
an OpenAI model and needs neither an OpenAI SDK nor an OpenAI API key: both
clients connect to the same client-neutral MCP endpoint.

Keep real keys and tokens in gitignored `.env` files or the deployment secret
store. This document and both committed `.env.example` files contain
placeholders only.

The required scope list is defined once by
`../../domain/auth/mcpOAuth.ts`'s `MCP_OAUTH_SCOPES`:

```text
openid profile email user:org:read
```

Keep Clerk's defaults and every operator check character-identical to that
source of truth.

## 1. Configure the same public origin and Clerk instance

Set the mandatory server-side `ZPECS_PUBLIC_URL` in both deployments. Its value
must be identical in API and web:

```dotenv
# Local development
ZPECS_PUBLIC_URL="http://localhost:3004"

# Production (current canonical origin)
ZPECS_PUBLIC_URL="https://zpecs-api-production.up.railway.app"
```

The value is an origin only: no path, query, fragment, credentials, or trailing
slash. HTTP is accepted only for a loopback address; every deployed origin must
use HTTPS. API and web fail at startup when this contract is missing or
invalid.

The API publishes these values from that origin, never from `Host`,
`Forwarded`, `X-Forwarded-*`, or the incoming request URL:

- MCP resource: `${ZPECS_PUBLIC_URL}/mcp`
- protected-resource metadata:
  `${ZPECS_PUBLIC_URL}/.well-known/oauth-protected-resource/mcp`

`apps/web/.env` still needs `ZPECS_API_URL` for server-to-server API calls.
That value can describe private routing. The MCP address copied from the
Connection page is built exclusively from `ZPECS_PUBLIC_URL`.

Use the same Clerk key pair in API and web:

- `apps/web/.env` `CLERK_PUBLISHABLE_KEY` becomes
  `apps/web/.env` `VITE_CLERK_PUBLISHABLE_KEY`.
- `CLERK_SECRET_KEY` is identical in both files.

The API verifies OAuth access tokens and web session tokens against this one
issuer. Mixing Clerk tenants can make each app look healthy in isolation while
authenticated API requests fail.

## 2. Configure Organizations, DCR, PKCE, JWTs, and scopes

1. In **Clerk Dashboard → Organizations**, enable Organizations and turn
   **Allow personal accounts** off. zpecs scopes every request to an
   organization; a personal account has no workspace-bearing `org_id`.

2. In **Clerk Dashboard → OAuth applications**, enable **Dynamic Client
   Registration (DCR)**. Claude Code and Codex register themselves during
   connection; zpecs does not configure their client IDs, client secrets, or
   callback ports.

3. Confirm that the DCR authorization-code flow supports PKCE. The MCP clients
   are public clients, so the production flow must not depend on a client
   secret. Keep PKCE enabled if the Clerk tenant exposes a corresponding
   setting.

4. Configure Clerk to issue JWT access tokens for the MCP flow. zpecs verifies
   their signature, issuer, expiry, format, and audience, then reads the
   selected organization from the verified token. An opaque access token is
   not compatible with the current direct-claim path.

5. Set the DCR default scopes exactly:

   ```bash
   npx clerk@latest api instance/oauth_application_settings -X PATCH -d '{"default_scopes":["openid","profile","email","user:org:read"]}'
   ```

   `user:org:read` makes organization selection part of consent and allows the
   issued token to carry the selected `org_id`. `openid`, `profile`, and
   `email` are also required by zpecs; a valid token missing any one of the four
   scopes receives `403 insufficient_scope`.

6. Create a test user and a dedicated test organization, and make the user a
   member. Also exercise a user without an organization: Clerk should route
   that user to organization setup. At the API boundary, a valid full-scope
   token without `org_id` remains authenticated and follows zpecs' existing
   `no_workspace` remediation instead of restarting OAuth.

7. Remove any old statically configured OAuth client with a fixed callback
   port, or label it as an optional manual test client. It is not part of the
   product flow. Do not add its credentials to either zpecs app.

Under DCR there are no additional zpecs OAuth environment variables. Redirect
URI, client registration, and PKCE exchange are negotiated by the MCP client
and Clerk.

## 3. Verify discovery, the challenge, and token shape

Start `apps/web`, complete one real MCP OAuth flow, and run:

```bash
CLERK_PUBLISHABLE_KEY=pk_test_... \
ZPECS_BASE_URL=http://localhost:3004 \
ZPECS_ACCESS_TOKEN=... \
  libs/api/src/integration/clerk/verify.sh
```

For production, set `ZPECS_BASE_URL` to the exact `ZPECS_PUBLIC_URL`, for example
`https://zpecs-api-production.up.railway.app`. It must be an origin with no
trailing slash. `ZPECS_ACCESS_TOKEN` is optional, so discovery and the
unauthenticated challenge can be checked first.

The script requires all of the following:

- Clerk authorization-server metadata advertises DCR and all four scopes.
- zpecs protected-resource metadata has `resource` exactly equal to
  `${ZPECS_BASE_URL}/mcp` and advertises exactly the four required scopes.
- Any non-loopback resource uses HTTPS.
- An unauthenticated `POST /mcp` returns `401` and a `WWW-Authenticate` Bearer
  challenge whose `resource_metadata` is exactly
  `${ZPECS_BASE_URL}/.well-known/oauth-protected-resource/mcp` and whose `scope`
  contains all four required scopes.
- zpecs' authorization-server passthrough still exposes DCR and the scopes.
- When supplied, the access token is a JWT with a non-empty `org_id`.

The script never prints the access token, its payload, or individual claim
values. It reports only safe presence and format booleans. `org_role` is
reported only as present or absent; its absence does not fail this slice.

## 4. Direct claim path and userinfo fallback boundary

`authenticator.ts` reads organization identity from the payload only after
Clerk has verified the JWT for the canonical MCP resource audience. This keeps
the normal request path to one verification call.

Do not add a userinfo request speculatively. Add the already identified
userinfo fallback only if live OAuth evidence shows either of these cases
despite granted `user:org:read`:

- Clerk issues an opaque access token rather than a JWT; or
- the JWT has no `org_id` claim.

`verify.sh` fails with an explicit fallback-required message in either case.
A missing `org_role` by itself never triggers the fallback.

## 5. Connect Claude Code and OpenAI Codex

Use the public MCP URL shown on the Connection page. For local development the
commands are:

### Claude Code

```bash
claude mcp add --transport http zpecs http://localhost:3004/mcp
```

Complete consent and select an organization. To clear an old token or change
the selected organization:

```bash
claude mcp logout zpecs
```

Then reconnect in Claude Code and complete consent again. The add command and
endpoint stay unchanged.

### OpenAI Codex

Add the server, then start OAuth explicitly:

```bash
codex mcp add zpecs --url http://localhost:3004/mcp
codex mcp login zpecs
```

For reauthentication or a workspace change:

```bash
codex mcp logout zpecs
codex mcp login zpecs
```

The organization selected during consent is bound to the issued MCP token as
`org_id`. The first authenticated request JIT-provisions that organization's
zpecs workspace. Switching the web `OrganizationSwitcher` does not rewrite an
existing Claude or Codex token; use the client-specific logout/login flow and
select the other organization during consent.

The idempotent `project:bootstrap` command remains available as an operations
tool for pre-provisioning or recovery. It is not a prerequisite for normal
users and must not be presented as the empty-state remedy:

```bash
vp run project:bootstrap -- --clerk-org-id org_... --name "Project name"
```

Both provisioning paths trim names, enforce 1–120 characters, and share the
database's case-insensitive per-workspace uniqueness boundary. Project
containers are unversioned and empty. All Epic, Stream, and Task writes remain
exclusive to MCP change sets.

## 6. Capture the Codex end-to-end evidence

Use the dedicated test organization and the production HTTPS URL:

1. Run `codex mcp add zpecs --url https://…/mcp`.
2. Run `codex mcp login zpecs`, finish browser login, and select the test
   organization.
3. Start a new Codex session and use `/mcp` to confirm that `zpecs` is active.
4. Confirm that Codex discovers exactly the existing six zpecs tools.
5. Call the read-only `get_entity_schema` tool with `entity: "task"`.
6. Restart Codex and confirm that configuration and OAuth credentials persist.
7. Run `codex mcp logout zpecs`, then `codex mcp login zpecs`, and confirm the
   reauthentication path.

Do not call `apply_change_set`. Expected persistent effects are limited to the
Clerk DCR registration, local OAuth credentials, and the existing JIT upsert of
the selected test workspace.

## 7. Rollout order and token compatibility

1. Set the same production `ZPECS_PUBLIC_URL` in the API and web Railway
   services before deploying code.
2. Deploy the API first. Verify the HTTPS protected-resource metadata, the
   `401` challenge, the `403 insufficient_scope` contract, and Claude Code.
3. Complete the real Codex flow and confirm that Clerk issues the canonical
   MCP resource as the token audience. If it does not, stop the release; do not
   weaken audience validation and do not publish the Codex UI.
4. Deploy the web UI only after the Codex end-to-end check succeeds.
5. Monitor existing HTTP 401/403 and coarse auth-status events. Do not log
   access tokens or claims.

Changing the canonical resource from the previously advertised internal HTTP
URL to the public HTTPS URL can invalidate the audience/resource binding of
already-issued tokens. Existing Claude users may need one logout/reconnect
cycle; communicate that reauthentication before rollout.

## 8. Roll out self-service project creation

The schema change adds stricter invariants to existing project rows. Follow the
collision preflight, deploy order, and privacy-safe monitoring runbook in
[`docs/project-self-service-rollout.md`](../../../../../docs/project-self-service-rollout.md).
Do not push the schema until both preflight queries return no rows.
