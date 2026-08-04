# Clerk instance setup — handover checklist

Status as of Task A2: **no Clerk instance exists**. Every step below is
unexecuted. This document is what the user runs by hand; nothing in it has
been verified against a live instance, and no step's output is claimed here —
see `verify.sh` in this directory for how to capture that evidence once the
steps below are done.

The code that depends on the outcome of this checklist is
`../../api/mcp/wellKnown.ts`. In particular, the scope list in step 3 below
must stay character-identical to that file's exported `MCP_OAUTH_SCOPES`
constant — `wellKnown.test.ts` reads this file and fails if the two diverge.

## 1. Runbook

1. **Clerk Dashboard → Organizations → enable Organizations.** Turn **"Allow
   personal accounts" off.** zpecs has no personal-account workspace concept —
   every request must resolve to an organization, or there is no `org_id` and
   therefore no workspace.

2. **Clerk Dashboard → OAuth applications → enable Dynamic Client
   Registration (DCR).** Most MCP clients register themselves against the
   authorization server at connect time; without DCR on, that registration
   has nowhere to go.

3. **Set default scopes.** This setting only appears once DCR (step 2) is
   on, and it exists because MCP clients frequently omit the `scope`
   parameter on registration — Clerk then falls back to its own default,
   which is `email offline_access profile` and does **not** include `openid`.
   Run:

   ```bash
   npx clerk@latest api instance/oauth_application_settings -X PATCH -d '{"default_scopes":["openid","profile","email","user:org:read"]}'
   ```

   That list must be character-identical to `MCP_OAUTH_SCOPES` in
   `../../api/mcp/wellKnown.ts`. If you change one, change the other and this
   file together.

4. **Check redirect behaviour.** MCP clients redirect back to either a
   loopback address (`http://127.0.0.1:<port>/callback`, port chosen by the
   client at OAuth-start time) or `https://claude.ai/api/mcp/auth_callback`.
   Whether this Clerk instance enforces a redirect-URI allowlist is unknown
   without checking the dashboard. If it does, both patterns need an entry —
   the loopback one typically needs to be entered as a pattern
   (`http://127.0.0.1:*/callback` or equivalent), not a single fixed port,
   since the client picks the port per session.

## 2. Env variables to fill in

| Variable                | Where                | What it does                                                                                                                                                                                                         |
| ----------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLERK_PUBLISHABLE_KEY` | `apps/web/.env` | `wellKnown.ts` derives the Clerk instance's Frontend API domain from this key (see the `deriveFapiUrl` comment in that file) — there is no separate "Clerk domain" variable to set. Starts `pk_test_` or `pk_live_`. |
| `CLERK_SECRET_KEY`      | `apps/web/.env` | Already present as a placeholder from Task A1. Not read by any code from this task — A4 wires it into token verification. Fill it in now anyway so A4 does not block on this checklist a second time.                |

Both currently hold the literal placeholder `..._placeholder_not_wired_in_yet`
in `.env` and `.env.example`. Replace the value in `.env` only — `.env.example`
must stay a placeholder since it is committed.

## 3. The open question: does the access token carry `org_id` and `org_role`?

This is the empirical question the plan's Task A2 exists to answer, and this
task explicitly could not answer it — there is no live instance to call. Once
one exists, running `verify.sh` (this directory) captures the evidence. Until
then, this stays open.

**Why it matters:** `org_id` is what lets zpecs resolve which workspace a
request belongs to at all (§ fail-closed auth table in
`global-constraints.md` — a valid token with no resolvable `org_id` must
answer 200 with every tool call `isError`, never 401, or the client loops the
OAuth flow forever). `org_role` decides whether role-based gating is _possible_
later — it is explicitly **not** built in the MVP either way, so a "no" answer
here changes nothing about what ships now, only what could be added after.

**Three candidate paths, in the order the plan names them:**

1. **On `@clerk/backend`'s auth object directly.** This is the fast path if
   it works — no extra network call. It is also the one we can already rule
   partially out from the SDK's own types: `@clerk/backend@3.15.0` types the
   `oauth_token` auth object (what you get back from an OAuth-flow-issued
   token, as opposed to an API key) as
   `{ userId, clientId, scopes, subject, … }` — **no `orgId` field.** Only the
   `api_key` auth object type carries `orgId`. This is a fact about the
   package's `.d.ts`, not a claim about runtime behavior against a live
   instance, and it is enough to say this path likely does not carry `org_id`
   for an OAuth-issued token — but "likely" is doing real work in that
   sentence; verify it, don't take the types as final proof the field is
   truly absent at runtime.

2. **From the already-verified JWT's claims.** If Clerk puts `org_id` (and
   maybe `org_role`) directly in the access token's claims, decoding the JWT
   that `@clerk/backend` already verified gets you both fields with no extra
   call. `verify.sh` decodes (without re-verifying) exactly this token and
   prints its claims for this reason.

3. **From the userinfo endpoint.** A second HTTP call, but the standard OIDC
   userinfo response for an org-scoped Clerk token is documented (by Clerk)
   to include `org_id`, `org_name`, and `org_slug` — the last two are enough
   to create the workspace row without a second lookup back to Clerk's
   Backend API. If path 1 and 2 both come up empty, this is the fallback,
   and it is the only one of the three that also hands you `org_name`/
   `org_slug` for free.

## 4. What the answer changes

- If `org_id` is available (by any of the three paths): A3/A4 proceed as
  planned — JIT-upsert the workspace on first sight of an `org_id` the
  database has not seen, resolve `WorkspaceScope` from it on every request.
- If `org_role` is available: role-based gating becomes _possible_ in a later
  milestone. It is **not** built now regardless — `global-constraints.md`
  states no role-based gating in the MVP, `confirm: true` is the only
  destructive gate. An unverified `org_role` does not block anything in this
  plan; it only forecloses a future option if it turns out to be absent.
