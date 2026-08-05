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
 */
export function createApiClient(sessionToken: string) {
  return treaty<App>(env.ZPECS_API_URL, {
    headers: { authorization: `Bearer ${sessionToken}` },
    // `parseDate` defaults to true, and that default is a type lie. Treaty walks
    // the parsed body and revives anything ISO-8601-shaped into a `Date`, while
    // the inferred type still says `string` because it comes from the API's Zod
    // response schema. So `createdAt.slice(0, 10)` compiles and throws. Every
    // timestamp this API returns is affected — `createdAt` and `updatedAt` on
    // the project and on all three entity levels. Turning it off is what makes
    // the types true; formatting a string is this app's job.
    parseDate: false,
  });
}
