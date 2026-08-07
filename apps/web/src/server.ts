import handler, { createServerEntry } from "@tanstack/react-start/server-entry";
import { runtimeApp } from "~/server/zpecsRuntime.server";

// Only the MCP transport and its OAuth discovery documents are public Elysia
// endpoints. Workspace routes remain available to server functions through
// direct Treaty calls, but cannot be reached over the web origin.
const PUBLIC_ZPECS_PATHS = new Set([
  "/mcp",
  "/mcp/",
  "/.well-known/oauth-protected-resource/mcp",
  "/.well-known/oauth-protected-resource/mcp/",
  "/.well-known/oauth-authorization-server",
  "/.well-known/oauth-authorization-server/",
]);

export default createServerEntry({
  fetch(...args) {
    const [request] = args;
    const { pathname } = new URL(request.url);

    // Preserve the original Request. In particular, the MCP transport must be
    // the first consumer of its body stream.
    return PUBLIC_ZPECS_PATHS.has(pathname) ? runtimeApp.fetch(request) : handler.fetch(...args);
  },
});
