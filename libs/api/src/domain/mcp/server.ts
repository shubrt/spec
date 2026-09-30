import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SERVER_INSTRUCTIONS } from "./instructions";
import { specTools } from "./registry";
import { registerSpecResources } from "./resources";

/**
 * Reported as `serverInfo.name` in the `initialize` result. The MCP client keys
 * its connection entry off this, so it is part of the wire contract.
 */
export const MCP_SERVER_NAME = "spec";
export const MCP_SERVER_VERSION = "0.1.0";

/**
 * A fresh server per request — the transport is stateless, so nothing may be
 * shared across POSTs.
 *
 * It takes no auth argument by design. The caller's identity travels as the SDK's
 * `authInfo` through `transport.handleRequest`, which is what puts it on every
 * tool handler's `extra`; passing it in here instead would work only because the
 * server is per-request and would quietly break the day it is not.
 */
export function createMcpServer(): McpServer {
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    // Returned once in the `initialize` result and then resident for the whole
    // session, which is why it has a character budget (`instructions.ts`).
    { instructions: SERVER_INSTRUCTIONS },
  );

  for (const tool of specTools) {
    tool.register(server);
  }
  registerSpecResources(server);

  return server;
}
