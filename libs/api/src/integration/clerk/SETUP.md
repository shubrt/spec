# Canonical Clerk instance — setup and live verification

The Clerk tenant configured in `apps/web/.env` is zpecs' canonical
instance. Its API key pair already makes API discovery work. Keep real keys in
gitignored `.env` files only; this document and both committed `.env.example`
files contain placeholders.

API discovery alone does not prove Dynamic Client Registration (DCR), an
organization-bearing access token, or the signed-in Web/MCP flow. Complete the
runbook below, then capture that evidence with `verify.sh` and the live MVP
verification document.

The scope list in this runbook must stay character-identical to
`../../api/mcp/wellKnown.ts`'s exported `MCP_OAUTH_SCOPES`; that constant is the
source of truth for zpecs' advertised scopes.

## 1. Use the same Clerk instance in API and web

Copy the canonical values without committing either `.env` file:

- `apps/web/.env` `CLERK_PUBLISHABLE_KEY` becomes
  `apps/web/.env` `VITE_CLERK_PUBLISHABLE_KEY`.
- `CLERK_SECRET_KEY` is identical in both files.

The API verifies OAuth access tokens and web session tokens against this one
issuer. Mixing tenants can make each app appear healthy in isolation while
every authenticated API request fails.

## 2. Configure Organizations and DCR

1. In **Clerk Dashboard → Organizations**, enable Organizations and turn
   **Allow personal accounts** off. zpecs scopes every request to an
   organization; a personal account has no workspace-bearing `org_id`.

2. In **Clerk Dashboard → OAuth applications**, enable **Dynamic Client
   Registration**. MCP clients then register themselves during connection;
   zpecs does not configure a client ID, client secret, or fixed callback port.

3. Set the DCR default scopes exactly:

   ```bash
   npx clerk@latest api instance/oauth_application_settings -X PATCH -d '{"default_scopes":["openid","profile","email","user:org:read"]}'
   ```

   `user:org:read` makes organization selection part of consent and allows the
   issued token to carry the selected `org_id`. `openid`, `profile`, and
   `email` are the other scopes zpecs advertises.

4. Create a test user and at least one organization, and make the user a
   member. Also create a user with no organization and confirm that Clerk sends
   that user to organization setup rather than issuing an organization-less
   token or looping OAuth. With personal accounts disabled, the live provider
   normally stops this case before zpecs; zpecs' own `no_workspace` remediation
   remains covered at the authenticated API boundary.

5. Remove any old statically configured OAuth client with a fixed callback port,
   or label it as an optional manual test client. It is not part of the product
   flow. Do not add its client ID or secret to either zpecs app.

Under DCR there are no additional zpecs OAuth environment variables. The only
Clerk variables are the publishable and secret keys listed above; redirect URI,
OAuth client ID, and OAuth client secret are negotiated/configured by the MCP
client and Clerk rather than zpecs.

## 3. Verify discovery and token claims

Start `apps/web`, complete one real MCP OAuth flow, and run:

```bash
CLERK_PUBLISHABLE_KEY=pk_test_... \
ZPECS_BASE_URL=http://localhost:3004 \
ZPECS_ACCESS_TOKEN=... \
  libs/api/src/integration/clerk/verify.sh
```

`ZPECS_ACCESS_TOKEN` is optional so discovery can be checked first. When it is
provided, the script never prints the token or its complete payload. It reports
only the token format and selected organization fields.

The script requires all of the following:

- Clerk's authorization-server metadata has a non-empty
  `registration_endpoint`, proving DCR is advertised.
- Clerk supports all four zpecs scopes.
- zpecs' protected-resource metadata advertises exactly those four scopes.
- zpecs' authorization-server passthrough still exposes DCR and the four
  scopes.
- A supplied JWT has a non-empty `org_id`.

`org_role` is reported when present, but its absence does not fail the MVP.
Role-based destructive gates are follow-up work; `confirm: true` remains the
only destructive confirmation in this branch.

## 4. Direct claim path and conditional userinfo fallback

`authenticator.ts` currently reads `org_id`, `org_name`, and `org_slug` from
the payload of the access token that Clerk has already verified. This keeps the
normal request path to one Clerk verification call.

Do not add a userinfo request speculatively. Add the already identified
userinfo fallback only if the live OAuth evidence shows either of these cases
despite granted `user:org:read`:

- Clerk issues an opaque access token rather than a JWT; or
- the JWT has no `org_id` claim.

`verify.sh` fails with an explicit fallback-required message in either case.
After implementing the fallback, repeat the token check and the no-organization
remediation scenario. A missing `org_role` by itself never triggers the
fallback and does not block this MVP.

## 5. Connect and provision

The standard DCR connection has no preconfigured client credentials:

```bash
claude mcp add --transport http zpecs http://localhost:3004/mcp
```

Complete consent and choose an organization. The first authenticated request
JIT-provisions its workspace. From then on, every member of the active
organization can create a project in the web app. The corresponding
`POST /workspace/projects` request derives its workspace only from the verified
Clerk session; callers cannot select a tenant in the request body.

The idempotent `project:bootstrap` command remains available as an operations
tool for pre-provisioning or recovery after that JIT workspace request. It is no
longer a prerequisite for normal users and must not be presented as the empty
state remedy:

```bash
vp run project:bootstrap -- --clerk-org-id org_... --name "Project name"
```

Both paths trim names, enforce 1–120 characters and share the database's
case-insensitive per-workspace uniqueness boundary. Project containers are
unversioned and empty. All Epic, Stream and Task writes remain exclusive to MCP
change sets.

The chosen organization is fixed in the issued MCP token. Switching the web
`OrganizationSwitcher` does not rewrite that token: open `/mcp` in Claude Code,
choose **Clear authentication** for zpecs (or run `claude mcp logout zpecs`),
reconnect, and select the other organization during consent. The endpoint and
`claude mcp add` command remain the same.

## 6. Roll out self-service project creation

The schema change adds stricter invariants to existing project rows. Follow the
collision preflight, deploy order and privacy-safe monitoring runbook in
[`docs/project-self-service-rollout.md`](../../../../../docs/project-self-service-rollout.md).
Do not push the schema until both preflight queries return no rows.
