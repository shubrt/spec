import Elysia from "elysia";
import { env } from "../../_/env";
import { MCP_OAUTH_SCOPES } from "../../domain/auth/mcpOAuth";
import { MCP_RESOURCE_URL, PROTECTED_RESOURCE_METADATA_URL } from "./publicUrl";

const PROTECTED_RESOURCE_METADATA_PATH = new URL(PROTECTED_RESOURCE_METADATA_URL).pathname;

/**
 * Clerk's Frontend API (FAPI) URL — the issuer that signs access tokens and
 * that publishes Clerk's own OAuth metadata — is never configured as a
 * separate env var. It is encoded inside the publishable key: strip the
 * `pk_test_`/`pk_live_` prefix, undo the URL-safe base64 substitution, and
 * base64-decode; the result is the FAPI host with a trailing `$` for the
 * key's checksum byte.
 *
 * Ported verbatim from `@clerk/mcp-tools@0.6.0`'s `deriveFapiUrl`
 * (dist/server.mjs) — that package is explicitly not installed here (see
 * global-constraints.md), so its one load-bearing algorithm is reproduced by
 * hand instead of re-guessed. Verified against the published npm tarball, not
 * against a live Clerk instance.
 */
function deriveFapiUrl(publishableKey: string): string {
  const normalizedKey = publishableKey
    .replace(/^pk_(test|live)_/, "")
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const paddedKey = normalizedKey.padEnd(Math.ceil(normalizedKey.length / 4) * 4, "=");
  return `https://${atob(paddedKey).replace(/\$/, "")}`;
}

function clerkNotConfigured(): Response {
  return Response.json(
    {
      error: "clerk_not_configured",
      message:
        "CLERK_PUBLISHABLE_KEY is not set (or is still the .env placeholder) — see " +
        "libs/api/src/integration/clerk/SETUP.md before relying on this endpoint.",
    },
    { status: 500 },
  );
}

/**
 * RFC 9728 OAuth 2.0 Protected Resource Metadata, at the path-scoped
 * well-known URI RFC 9728 §3.1 describes for a resource identifier with a
 * path component (`https://host/mcp` → `/.well-known/oauth-protected-resource/mcp`).
 *
 * `resource` is the configured public identifier. Request and forwarded host
 * headers cannot change what clients discover or what audience tokens need.
 */
function protectedResourceMetadata(): Response {
  const publishableKey = env.CLERK_PUBLISHABLE_KEY;
  if (!publishableKey) return clerkNotConfigured();

  return Response.json({
    resource: MCP_RESOURCE_URL,
    authorization_servers: [deriveFapiUrl(publishableKey)],
    scopes_supported: MCP_OAUTH_SCOPES,
    // "header" is the only bearer method the MCP transport ever uses
    // (`Authorization: Bearer <token>`) — never body or query string.
    bearer_methods_supported: ["header"],
  });
}

/**
 * Passthrough OAuth 2.0 Authorization Server Metadata (RFC 8414) at the
 * pre-RFC-9728 well-known location, for MCP clients that still resolve
 * `.well-known/oauth-authorization-server` against the resource server's own
 * host instead of following `authorization_servers` from the protected
 * resource metadata above. The MCP spec now calls this endpoint optional but
 * "useful for older clients" (Clerk's own MCP guide, `build-mcp-server.mdx`).
 *
 * This is a live proxy, not a locally-built document: it fetches Clerk's real
 * metadata and relays it verbatim. The canonical Clerk instance's discovery
 * endpoint works, while DCR and the consent flow still need the live evidence
 * described in `integration/clerk/verify.sh`; duplicating Clerk-owned fields
 * locally would make that evidence stale. The fetch target
 * (`<fapi>/.well-known/oauth-authorization-server`) mirrors
 * `@clerk/mcp-tools@0.6.0`'s `fetchClerkAuthorizationServerMetadata`.
 */
async function authorizationServerMetadata(): Promise<Response> {
  const publishableKey = env.CLERK_PUBLISHABLE_KEY;
  if (!publishableKey) return clerkNotConfigured();

  const upstreamUrl = `${deriveFapiUrl(publishableKey)}/.well-known/oauth-authorization-server`;
  try {
    const upstream = await fetch(upstreamUrl);
    if (!upstream.ok) {
      return Response.json(
        {
          error: "upstream_metadata_unavailable",
          message: `Clerk answered ${upstream.status} for ${upstreamUrl}`,
        },
        { status: 502 },
      );
    }
    return Response.json(await upstream.json());
  } catch (error) {
    return Response.json(
      {
        error: "upstream_metadata_unavailable",
        message: `Failed to reach ${upstreamUrl}: ${(error as Error).message}`,
      },
      { status: 502 },
    );
  }
}

/**
 * Both documents are public — no auth. A4 adds auth to `POST /mcp` only; a
 * client cannot start the OAuth flow at all if reaching these needed a token
 * first.
 */
export const wellKnownRoutes = new Elysia()
  .get(PROTECTED_RESOURCE_METADATA_PATH, ({ set }) => {
    const response = protectedResourceMetadata();
    set.status = response.status;
    return response;
  })
  .get("/.well-known/oauth-authorization-server", async ({ set }) => {
    const response = await authorizationServerMetadata();
    set.status = response.status;
    return response;
  });
