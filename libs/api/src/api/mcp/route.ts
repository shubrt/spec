import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import Elysia from "elysia";
import { resolveMcpAuth } from "../../domain/auth/resolveMcpAuth";
import { createMcpServer } from "../../domain/mcp/server";
import { PROTECTED_RESOURCE_METADATA_PATH } from "./wellKnown";

/**
 * The RFC 9728 §5.1 challenge: 401 plus a `WWW-Authenticate` header naming the
 * URL of this resource server's protected-resource metadata. That header is how
 * an MCP client discovers *which* authorization server to run the OAuth flow
 * against; without it the client has nothing to go on and reports the server as
 * simply broken.
 *
 * The URL is built from the incoming request, not from a configured base URL, so
 * it stays correct under localhost, a tunnel and production alike — the same
 * choice `wellKnown.ts` makes for the `resource` field it has to match.
 *
 * `error_description` in the header is a fixed string on purpose: Clerk's
 * failure reason goes in the JSON body, where it needs no quoted-string
 * escaping and cannot break a header a client has to parse.
 */
function unauthorized(request: Request, reason: string): Response {
  const metadataUrl = new URL(request.url);
  metadataUrl.pathname = PROTECTED_RESOURCE_METADATA_PATH;
  metadataUrl.search = "";

  return Response.json(
    {
      error: "invalid_token",
      error_description: "The access token is missing, expired or not valid for this resource.",
      reason,
    },
    {
      status: 401,
      headers: {
        "WWW-Authenticate":
          'Bearer error="invalid_token", ' +
          'error_description="The access token is missing, expired or not valid for this resource.", ' +
          `resource_metadata="${metadataUrl.toString()}"`,
      },
    },
  );
}

/**
 * 500, not 401: the token was never even examined because this deployment has no
 * `CLERK_SECRET_KEY`. Answering 401 would start an OAuth flow that cannot
 * succeed and would loop, which is exactly the failure mode the fail-closed
 * table exists to prevent. Mirrors `wellKnown.ts`'s handling of a missing
 * publishable key.
 */
function clerkNotConfigured(): Response {
  return Response.json(
    {
      error: "clerk_not_configured",
      message:
        "CLERK_SECRET_KEY is not set, so no access token can be verified — see " +
        "libs/api/src/integration/clerk/SETUP.md.",
    },
    { status: 500 },
  );
}

/**
 * Authenticates the request, then hands the raw `Request` to a freshly built
 * stateless server + transport.
 *
 * Exported so the route test can mount the exact same handler behind a control
 * route that deliberately omits `{ parse: "none" }`.
 */
export async function handleMcpRequest(request: Request): Promise<Response> {
  const outcome = await resolveMcpAuth(request);
  if (outcome.status === "not_configured") return clerkNotConfigured();
  if (outcome.status === "invalid_token") return unauthorized(request, outcome.reason);

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  const server = createMcpServer();
  await server.connect(transport);

  // The resolved identity travels as `authInfo` through the transport's own
  // options, which is what puts it on every tool handler's `extra`. It is
  // emphatically not re-derived inside the MCP layer: reading the request a
  // second time consumes the body stream (measured in A0).
  return transport.handleRequest(request, { authInfo: outcome.authInfo });
}

export const mcpRoute = new Elysia().post("/mcp", ({ request }) => handleMcpRequest(request), {
  // Load-bearing guard, not a style choice. The transport reads the body off
  // the `Request` itself, so nothing upstream may consume the stream first.
  //
  // Measured in A0 and re-measured in A4: Elysia's AOT codegen only injects body
  // parsing when something in the route reads `body`. Auth reads *headers*, so
  // the handler below still never names `body` and removing this option still
  // happens to keep the tests green. The moment anything on this route reads
  // `body` — a `body` schema, a `derive`/`resolve` hook that touches it — Elysia
  // consumes the stream and the transport answers
  //   HTTP 400 {"jsonrpc":"2.0","error":{"code":-32700,
  //             "message":"Parse error: Invalid JSON"},"id":null}
  // The option therefore stays as a forward guard, and route.test.ts pins both
  // halves: that this route declares it, and that the production handler behind
  // a route which reads `body` really does produce that -32700.
  parse: "none",
});
