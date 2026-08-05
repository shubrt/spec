import { createServerFn } from "@tanstack/react-start";
import { env } from "~/lib/env";

/**
 * Where an MCP client connects, and the line that points it there.
 *
 * This has to come from the server: `ZPECS_API_URL` is deliberately not
 * `VITE_`-prefixed, because keeping the API origin off `import.meta.env` is what
 * stops the browser reaching a session-authenticated multi-tenant API directly.
 * So the value is read here and handed to the page as a string.
 */

export interface McpEndpoint {
  readonly url: string;
  readonly command: string;
  /**
   * Whether the origin is a loopback address.
   *
   * The page says so out loud when it is. A command line is made to be copied,
   * and a `localhost` URL pasted into a colleague's client is a support ticket
   * that looks like a bug in zpecs.
   */
  readonly isLocal: boolean;
}

export const getMcpEndpoint = createServerFn({ method: "GET" }).handler((): McpEndpoint => {
  // One path, no workspace segment. The workspace comes from the `org_id` claim
  // in the OAuth token, not from the URL — so there is deliberately no
  // per-workspace endpoint to construct.
  const url = new URL("/mcp", env.ZPECS_API_URL);

  return {
    url: url.toString(),
    command: `claude mcp add --transport http zpecs ${url.toString()}`,
    isLocal: url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1",
  };
});
