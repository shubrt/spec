import { createServerFn } from "@tanstack/react-start";
import { env, isLoopbackHostname } from "~/lib/env";

/**
 * Where an MCP client connects.
 *
 * This has to come from the server: `ZPECS_PUBLIC_URL` is deliberately not
 * `VITE_`-prefixed: even though it is also the web origin, the canonical OAuth
 * resource must come from trusted deployment configuration rather than browser
 * location or request headers. The value is handed to the page as a string.
 */

export interface McpEndpoint {
  readonly url: string;
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
  const url = new URL("/mcp", env.ZPECS_PUBLIC_URL);

  return {
    url: url.toString(),
    isLocal: isLoopbackHostname(url.hostname),
  };
});
