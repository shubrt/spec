# Canonical Clerk instance — setup and live verification

The Clerk tenant configured in the repository-root `.env` is spec's canonical
authorization server for both Claude Code and OpenAI Codex. The shared
`@spec/api` Elysia app runs inside that TanStack Start service. spec does
not run an OpenAI model and needs neither an OpenAI SDK nor an OpenAI API key:
both clients connect to the same client-neutral MCP endpoint on the web origin.

Keep real keys and tokens in the gitignored root `.env` or the deployment
secret store. This document and the committed root `.env.example` file contain
placeholders only.

The required scope list is defined once by
`../../domain/auth/mcpOAuth.ts`'s `MCP_OAUTH_SCOPES`:

```text
openid profile email user:org:read
```

Keep Clerk's defaults and every operator check character-identical to that
source of truth.

## 1. Configure the public web origin and Clerk instance

Set the mandatory server-side `SPEC_PUBLIC_URL` in the sole `apps/web`
deployment:

```dotenv
# Local development without portless (`PORTLESS=0 vp run dev`). Under plain
# `vp run dev` portless supplies the origin, e.g. https://spec.localhost
SPEC_PUBLIC_URL="http://localhost:3005"

# Production (use the existing canonical web origin)
SPEC_PUBLIC_URL="https://spec.example.com"
```

The value is an origin only: no path, query, fragment, credentials, or trailing
slash. HTTP is accepted only for a loopback address; every deployed origin must
use HTTPS. The web service fails at startup when this contract is missing or
invalid.

The Elysia runtime publishes these values from that origin, never from `Host`,
`Forwarded`, `X-Forwarded-*`, or the incoming request URL:

- MCP resource: `${SPEC_PUBLIC_URL}/mcp`
- protected-resource metadata:
  `${SPEC_PUBLIC_URL}/.well-known/oauth-protected-resource/mcp`

Only `/mcp` and the OAuth discovery endpoints are exposed through the TanStack
server entry. `/workspace*` is not a public REST surface: TanStack server
functions call the shared Elysia app in-process through Eden Treaty. There is no
`SPEC_API_URL` or second service-to-service hop. The MCP address copied from the
Connection page is built exclusively from `SPEC_PUBLIC_URL`.

Configure the Clerk key pair in the repository-root `.env`:

- `VITE_CLERK_PUBLISHABLE_KEY` is the canonical publishable-key variable used
  by the browser, TanStack middleware and shared Elysia runtime.
- `CLERK_SECRET_KEY` remains server-only.

Both OAuth access tokens and web session tokens are verified against this one
issuer. The browser session and MCP flow must therefore use the same Clerk
tenant.

## 2. Configure Organizations, DCR, PKCE, JWTs, and scopes

1. In **Clerk Dashboard → Organizations**, enable Organizations and turn
   **Allow personal accounts** off. spec scopes every request to an
   organization; a personal account has no workspace-bearing `org_id`.

2. In **Clerk Dashboard → OAuth applications**, enable **Dynamic Client
   Registration (DCR)**. Claude Code and Codex register themselves during
   connection; spec does not configure their client IDs, client secrets, or
   callback ports.

3. Confirm that the DCR authorization-code flow supports PKCE. The MCP clients
   are public clients, so the production flow must not depend on a client
   secret. Keep PKCE enabled if the Clerk tenant exposes a corresponding
   setting.

4. Keep Clerk's default JWT access-token format for the MCP flow. Clerk's SDK
   verifies that the bearer is an OAuth token and validates its signature,
   issuer, expiry and any `aud` claim it carries. Current Clerk OAuth JWTs may
   omit `aud` and identify the authorized client through `azp`; that is a valid
   Clerk token shape and must not be rejected by a second decoded-token check.
   An opaque access token is not compatible with the current direct-claim path.

5. Set the DCR default scopes exactly:

   ```bash
   npx clerk@latest api instance/oauth_application_settings -X PATCH -d '{"default_scopes":["openid","profile","email","user:org:read"]}'
   ```

   `user:org:read` makes organization selection part of consent and allows the
   issued token to carry the selected `org_id`. `openid`, `profile`, and
   `email` are also required by spec; a valid token missing any one of the four
   scopes receives `403 insufficient_scope`.

6. Create a test user and a dedicated test organization, and make the user a
   member. Also exercise a user without an organization: Clerk should route
   that user to organization setup. At the Elysia auth boundary, a valid
   full-scope token without `org_id` remains authenticated and follows spec's
   existing `no_workspace` remediation instead of restarting OAuth.

7. Remove any old statically configured OAuth client with a fixed callback
   port, or label it as an optional manual test client. It is not part of the
   product flow. Do not add its credentials to the spec web app.

Under DCR there are no additional spec OAuth environment variables. Redirect
URI, client registration, and PKCE exchange are negotiated by the MCP client
and Clerk.

## 3. Verify discovery, the challenge, and token shape

Start `apps/web`, complete one real MCP OAuth flow, and run. Pass the value
of `VITE_CLERK_PUBLISHABLE_KEY` to the operator script under its
`CLERK_PUBLISHABLE_KEY` input name:

```bash
CLERK_PUBLISHABLE_KEY=pk_test_... \
SPEC_BASE_URL=https://spec.localhost \
SPEC_ACCESS_TOKEN=... \
  libs/api/src/integration/clerk/verify.sh
```

For production, set `SPEC_BASE_URL` to the exact canonical web
`SPEC_PUBLIC_URL`. It must be an origin with no trailing slash.
`SPEC_ACCESS_TOKEN` is optional, so discovery and the unauthenticated challenge
can be checked first.

The script requires all of the following:

- Clerk authorization-server metadata advertises DCR and all four scopes.
- spec protected-resource metadata has `resource` exactly equal to
  `${SPEC_BASE_URL}/mcp` and advertises exactly the four required scopes.
- Any non-loopback resource uses HTTPS.
- An unauthenticated `POST /mcp` returns `401` and a `WWW-Authenticate` Bearer
  challenge whose `resource_metadata` is exactly
  `${SPEC_BASE_URL}/.well-known/oauth-protected-resource/mcp` and whose `scope`
  contains all four required scopes.
- spec's authorization-server passthrough still exposes DCR and the scopes.
- When supplied, the access token is a JWT with a non-empty `org_id`.

The script never prints the access token, its payload, or individual claim
values. It reports only safe presence and format booleans. `org_role` is
reported only as present or absent; its absence does not fail this slice.

## 4. Direct claim path and userinfo fallback boundary

`authenticator.ts` reads organization identity from the payload only after
Clerk has verified the bearer as an OAuth JWT. The configured MCP resource is
passed to Clerk as `audience`, so a present `aud` claim is checked; Clerk OAuth
JWTs without that optional claim are accepted in the same way as Clerk's own
MCP middleware. This keeps the normal request path to one verification call.

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
claude mcp add --transport http spec https://spec.localhost/mcp
```

Complete consent and select an organization. To clear an old token or change
the selected organization:

```bash
claude mcp logout spec
```

Then reconnect in Claude Code and complete consent again. The add command and
endpoint stay on the web origin.

### OpenAI Codex

Add the server, then start OAuth explicitly:

```bash
codex mcp add spec --url https://spec.localhost/mcp
codex mcp login spec
```

For reauthentication or a workspace change:

```bash
codex mcp logout spec
codex mcp login spec
```

When migrating from the former API origin, remove the existing `spec` MCP entry
from each client, add it again with the web-origin URL, and complete OAuth
again. Configuration and tokens for the former origin are not carried forward.

The organization selected during consent is bound to the issued MCP token as
`org_id`. The first authenticated request JIT-provisions that organization's
spec workspace. Switching the web `OrganizationSwitcher` does not rewrite an
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

1. Run `codex mcp add spec --url https://…/mcp`.
2. Run `codex mcp login spec`, finish browser login, and select the test
   organization.
3. Start a new Codex session and use `/mcp` to confirm that `spec` is active.
4. Confirm that Codex discovers exactly the existing six spec tools.
5. Call the read-only `get_entity_schema` tool with `entity: "task"`.
6. Restart Codex and confirm that configuration and OAuth credentials persist.
7. Run `codex mcp logout spec`, then `codex mcp login spec`, and confirm the
   reauthentication path.

Do not call `apply_change_set`. Expected persistent effects are limited to the
Clerk DCR registration, local OAuth credentials, and the existing JIT upsert of
the selected test workspace.

## 7. Rollout order and token compatibility

1. Pause automatic deployments of the former API service while leaving its
   current deployment available for rollback during the release check.
2. Configure the web service with `SPEC_DATABASE_URL`, the Clerk variables,
   optional `SPEC_AXIOM_DATASET` and `SPEC_AXIOM_TOKEN`, and the exact canonical
   HTTPS web origin as `SPEC_PUBLIC_URL`. Deployments may use the generic
   `DATABASE_URL`, `AXIOM_DATASET`, and `AXIOM_TOKEN` fallback names.
3. Deploy the combined TanStack service. Verify the protected-resource
   metadata, the `401` challenge, the `403 insufficient_scope` contract, the
   web project flow, and one real read-only Claude or Codex MCP flow on the web
   origin.
4. Confirm that discovery and the OAuth requests use the canonical web MCP
   resource. If Clerk emits an `aud` claim, it must equal that resource. Do not
   treat Clerk's `azp` claim as a resource audience; it identifies the OAuth
   client/authorization party instead.
5. Publish the new Connection-page URL and operator guidance, then stop and
   remove the former API service in the same release. Remove `SPEC_API_URL` and
   the obsolete service configuration from the deployment environment.
6. Monitor HTTP 401/403 and coarse auth-status events. Do not log access tokens
   or claims.

Changing the canonical resource to the web origin invalidates the
audience/resource binding of tokens issued for the former API origin. There is
no compatibility or seven-day overlap period: users must immediately remove
the old MCP entry, add the web-origin URL, and authenticate again. Communicate
those steps as part of the release.

## 8. Roll out self-service project creation

The schema change adds stricter invariants to existing project rows. Follow the
collision preflight, deploy order, and privacy-safe monitoring runbook in
[`docs/project-self-service-rollout.md`](../../../../../docs/project-self-service-rollout.md).
Do not push the schema until both preflight queries return no rows.
