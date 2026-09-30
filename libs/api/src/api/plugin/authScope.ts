import Elysia from "elysia";
import { hasWorkspace } from "../../domain/auth/authContext";
import { resolveSessionAuth } from "../../domain/auth/resolveSessionAuth";

/**
 * ── ADR: spec takes exactly ONE Elysia lifecycle hook, and this is it ──────────
 *
 * A handler normally reads its own inputs, so what a route does is readable from
 * the route. This file is the one deliberate departure, because in Spec a
 * forgotten guard can produce a cross-workspace leak. That failure mode, not
 * convenience, is what buys a hook here and nowhere else.
 *
 * **Why `resolve` and not `derive`/`onRequest`/`onBeforeHandle`.** `resolve` runs
 * *after* validation, so a malformed request is rejected before any Clerk call or
 * database write happens (`resolveSessionAuth` performs a JIT workspace upsert —
 * it must not run for a request that was never going to be served). It also
 * *produces context*: the handler receives `scope` as a value it cannot obtain
 * any other way, so "I forgot the guard" is not a silent wrong answer, it is a
 * type error at the point of use.
 *
 * **Why `{ as: "scoped" }`.** `local` (the default) would confine the hook to
 * this plugin, which declares no routes of its own, so it would guard nothing.
 * `global` would put session auth on `POST /mcp` — which authenticates an OAuth
 * *access* token, not a session — and on the two public `.well-known` documents,
 * which a client must reach *before* it has any token at all. `scoped` reaches
 * exactly one level up: the handler file that wrote `.use(authScope)`. The guard
 * is therefore legible where it matters, at that call site, instead of being
 * hidden in global middleware that a new handler silently inherits or silently
 * escapes.
 *
 * ── Two things this ADR forbids ───────────────────────────────────────────────
 *
 * 1. **`onError` stays off.** spec renders an error across three boundaries and
 *    they need three distinct shapes: a JSON-RPC error object (protocol-level
 *    failure on `/mcp`), an `isError` tool result inside HTTP 200 (a tool ran and
 *    refused — the text is what a model reads), and an HTTP JSON error body (this
 *    file). A global error hook would flatten all three into one envelope and
 *    break at least two of them. Do not add one "for consistency".
 *
 * 2. **This is the only spec-owned domain/auth lifecycle hook.** Not the only
 *    `resolve` — the only hook allowed to affect request semantics. The
 *    executable runtime wraps the core app with evlog, whose internal hooks are
 *    a strictly observing exception: they may add/emit metadata but may never
 *    parse bodies, authorize requests, or transform an error response. A second
 *    spec-owned hook still needs a new ADR and a new reason.
 *
 * ──────────────────────────────────────────────────────────────────────────────
 *
 * Deliberately unnamed (no `{ name }` on the Elysia instance). A named plugin is
 * deduplicated on reuse, and with `as: "scoped"` that would mean a second handler
 * file's `.use(authScope)` silently resolves nothing. Unnamed, each `.use` really
 * applies the hook to its own parent — which for a tenant guard is the failure
 * mode worth paying a little duplicated work to avoid.
 */
export const authScope = new Elysia().resolve({ as: "scoped" }, async ({ request, status }) => {
  const outcome = await resolveSessionAuth(request);

  // 500, not 401: the session was never examined because this deployment has no
  // `CLERK_SECRET_KEY`. Mirrors `api/mcp/route.ts` — a 401 for a server-side
  // misconfiguration sends the browser into a sign-in flow that cannot succeed.
  if (outcome.status === "not_configured") {
    return status(500, {
      error: "clerk_not_configured" as const,
      message:
        "CLERK_SECRET_KEY is not set, so no session can be verified — see " +
        "libs/api/src/integration/clerk/SETUP.md.",
    });
  }

  // 401 with no `WWW-Authenticate`. This subtree is called by a browser holding a
  // Clerk session, not by an MCP client that has to discover an authorization
  // server, so an RFC 9728 challenge here would be noise the frontend ignores.
  if (outcome.status === "signed_out") {
    return status(401, { error: "signed_out" as const, reason: outcome.reason });
  }

  // 403, not 401. The fail-closed table's rule — "401 must never mean 'token fine
  // but no workspace'" — holds on this path too: a 401 tells the frontend the
  // session is bad and it signs the user out and back in, forever, because a new
  // session will not have an organization either. 403 says the identity is
  // established and the *action* is unavailable, which is the state the UI has to
  // render: create or join an organization.
  if (!hasWorkspace(outcome.auth)) {
    return status(403, {
      error: "no_workspace" as const,
      message:
        "You are signed in, but this session is not scoped to an organization, so there is " +
        "no spec workspace to read. Create or join an organization, then reload.",
    });
  }

  // `scope` is lifted out of `auth` even though it is `auth.scope`, so a handler
  // can name it directly as the first argument of a repository call and never has
  // to narrow the `AuthContext` union itself.
  return { auth: outcome.auth, scope: outcome.auth.scope };
});
