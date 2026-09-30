import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import Elysia from "elysia";
import { recordToolEvent } from "../../_/eventLog";
import { MCP_OAUTH_SCOPES } from "../../domain/auth/mcpOAuth";
import { resolveMcpAuth } from "../../domain/auth/resolveMcpAuth";
import { specTools } from "../../domain/mcp/registry";
import { createMcpServer } from "../../domain/mcp/server";
import { MCP_RESOURCE_URL, PROTECTED_RESOURCE_METADATA_URL } from "./publicUrl";

const SPEC_TOOL_NAMES = new Set<string>(specTools.map(({ name }) => name));
const MCP_OAUTH_SCOPE = MCP_OAUTH_SCOPES.join(" ");

/**
 * Seeds observability for calls the SDK may reject before a registered tool's
 * callback runs (unknown tool or invalid arguments). A clone keeps the original
 * stream untouched for the stateless transport. Only a known registry name is
 * retained; arbitrary client input is collapsed to a fixed marker, and no body
 * or arguments are attached to the event.
 */
async function recordRequestedTool(request: Request): Promise<void> {
  try {
    const message: unknown = await request.clone().json();
    if (typeof message !== "object" || message === null || !("method" in message)) return;
    if (message.method !== "tools/call" || !("params" in message)) return;
    const params = message.params;
    if (typeof params !== "object" || params === null || !("name" in params)) return;
    const name = params.name;
    const tool = typeof name === "string" && SPEC_TOOL_NAMES.has(name) ? name : "unknown";

    // Error is the safe default: a valid callback overwrites it with the real
    // outcome, while SDK-level rejections never reach that callback.
    recordToolEvent(tool, "error");
  } catch {
    // Malformed JSON is the transport's concern and carries no trustworthy tool
    // name. Observability must not replace its JSON-RPC parse error.
  }
}

/**
 * The RFC 9728 §5.1 challenge: 401 plus a `WWW-Authenticate` header naming the
 * URL of this resource server's protected-resource metadata. That header is how
 * an MCP client discovers *which* authorization server to run the OAuth flow
 * against; without it the client has nothing to go on and reports the server as
 * simply broken.
 *
 * The metadata URL is configured explicitly so proxy-controlled request headers
 * cannot change the resource clients discover.
 *
 * `error_description` in the header is a fixed string on purpose: Clerk's
 * failure reason goes in the JSON body, where it needs no quoted-string
 * escaping and cannot break a header a client has to parse.
 */
function unauthorized(reason: string): Response {
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
          `resource_metadata="${PROTECTED_RESOURCE_METADATA_URL}", ` +
          `scope="${MCP_OAUTH_SCOPE}"`,
      },
    },
  );
}

/** A valid token that needs renewed consent for spec's complete scope set. */
function insufficientScope(): Response {
  return Response.json(
    {
      error: "insufficient_scope",
      error_description: "The access token does not include all scopes required by this resource.",
    },
    {
      status: 403,
      headers: {
        "WWW-Authenticate":
          'Bearer error="insufficient_scope", ' +
          'error_description="The access token does not include all scopes required by this resource.", ' +
          `resource_metadata="${PROTECTED_RESOURCE_METADATA_URL}", ` +
          `scope="${MCP_OAUTH_SCOPE}"`,
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

/** Authenticates the request, then hands it to a fresh stateless server and transport. */
export async function handleMcpRequest(request: Request): Promise<Response> {
  const outcome = await resolveMcpAuth(request, MCP_RESOURCE_URL);
  if (outcome.status === "not_configured") return clerkNotConfigured();
  if (outcome.status === "invalid_token") return unauthorized(outcome.reason);
  if (outcome.status === "insufficient_scope") return insufficientScope();

  await recordRequestedTool(request);

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

export const mcpRoute = new Elysia().post(
  "/mcp",
  async ({ request, set }) => {
    const response = await handleMcpRequest(request);
    // Elysia preserves a returned Response's status on the wire but does not copy
    // it into `set.status`; evlog reads the latter in its observing after-response
    // hook. Mirror the already-decided status so the event cannot report a 401,
    // 403 or 500 as 200. No body or header is inspected here.
    set.status = response.status;
    return response;
  },
  {
    // Load-bearing guard, not a style choice. The transport reads the body off
    // the `Request` itself, so nothing upstream may consume the stream first.
    //
    // Measured in A0 and re-measured in A4: Elysia's AOT codegen only injects body
    // parsing when something in the route reads `body`. Auth reads *headers*, so
    // the handler below never names `body`. The moment anything on this route
    // reads `body` — a `body` schema, a `derive`/`resolve` hook that touches it — Elysia
    // consumes the stream and the transport answers
    //   HTTP 400 {"jsonrpc":"2.0","error":{"code":-32700,
    //             "message":"Parse error: Invalid JSON"},"id":null}
    // The option therefore stays as a forward guard against that -32700 response.
    parse: "none",
  },
);
