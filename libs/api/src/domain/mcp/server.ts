import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/**
 * Reported as `serverInfo.name` in the `initialize` result. The MCP client keys
 * its connection entry off this, so it is part of the wire contract.
 */
export const MCP_SERVER_NAME = "zpecs";
export const MCP_SERVER_VERSION = "0.1.0";

/**
 * `z.strictObject`, not `z.object`: the SDK converts input schemas with
 * `io: "input"`, which silently strips `additionalProperties: false` from a
 * plain `z.object()`.
 */
const pingInput = z.strictObject({
  message: z.string().describe("Text echoed back verbatim."),
});

/**
 * A fresh server per request — the transport is stateless, so nothing may be
 * shared across POSTs.
 */
export function createMcpServer(): McpServer {
  const server = new McpServer({ name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION });

  server.registerTool(
    "ping",
    {
      title: "Ping",
      description: "Liveness probe. Echoes the supplied message back.",
      inputSchema: pingInput,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    ({ message }) => ({ content: [{ type: "text", text: `pong: ${message}` }] }),
  );

  return server;
}
