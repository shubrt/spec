import { treaty } from "@elysiajs/eden";
import type { App } from "@zpecs/api";
import { env } from "~/lib/env";

/**
 * A Treaty client bound to one session.
 *
 * `App` is @zpecs/api's Elysia instance type, so every path, every response
 * status and every DTO on this client is the API's own — a renamed field on the
 * server becomes a type error here rather than an `undefined` at runtime.
 *
 * The token is per-request, so the client is built per-request too. The API
 * accepts a Clerk session token as `Authorization: Bearer`; sending the token
 * rather than forwarding the browser's Clerk cookie is what keeps this a plain
 * server-to-server call, with no cross-origin cookie semantics to get right and
 * no CORS on the API.
 *
 * If Treaty's types ever look stale, the cause is a built `libs/api/dist`:
 * TypeScript prefers `dist/_/index.d.mts` when it exists and only falls through
 * to `src/` while it is absent. Run `clean` in libs/api and re-check. Do
 * not rewrite that package's exports map — the mapping is deliberate.
 */
export function createApiClient(sessionToken: string) {
  return treaty<App>(env.ZPECS_API_URL, {
    headers: { authorization: `Bearer ${sessionToken}` },
  });
}
