import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import Elysia from "elysia";
import { createMcpServer } from "../../domain/mcp/server";

/**
 * Hands the raw `Request` to a freshly built stateless server + transport.
 *
 * Exported so the route test can mount the exact same handler behind a control
 * route that deliberately omits `{ parse: "none" }`.
 */
export async function handleMcpRequest(request: Request): Promise<Response> {
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  const server = createMcpServer();
  await server.connect(transport);
  return transport.handleRequest(request);
}

export const mcpRoute = new Elysia().post("/mcp", ({ request }) => handleMcpRequest(request), {
  // Load-bearing guard, not a style choice. The transport reads the body off
  // the `Request` itself, so nothing upstream may consume the stream first.
  //
  // Measured in A0: Elysia's AOT codegen only injects body parsing when
  // something in the route reads `body`, so with today's handler shape
  // (`{ request }` only) removing this option happens to keep the tests green.
  // The moment anything reads `body` — a `body` schema, or the auth resolver
  // A4 adds — Elysia consumes the stream and the transport answers
  //   HTTP 400 {"jsonrpc":"2.0","error":{"code":-32700,
  //             "message":"Parse error: Invalid JSON"},"id":null}
  // The option therefore stays, and route.test.ts pins that failure mode with
  // a control route so the dependency cannot silently rot.
  parse: "none",
});
