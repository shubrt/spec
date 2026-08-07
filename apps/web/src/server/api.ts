import { treaty } from "@elysiajs/eden";
import { runtimeApp } from "./zpecsRuntime.server";

/**
 * A Treaty client bound to one session.
 *
 * Treaty receives the Elysia instance directly, so every path, every response
 * status and every DTO is inferred from the shared API without a network hop.
 *
 * The token is per-request, so the client is built per-request too. The API
 * still accepts a Clerk session token as `Authorization: Bearer`; retaining the
 * same guard means direct calls cannot bypass workspace scoping just because
 * API and web now share one process.
 */
export function createApiClient(sessionToken: string) {
  return treaty(runtimeApp, {
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
