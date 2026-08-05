import { type ClerkClient, createClerkClient } from "@clerk/backend";
import { env } from "../../_/env";

/**
 * The Clerk Backend SDK client, built lazily and memoised.
 *
 * Lazily, because `CLERK_SECRET_KEY` is optional (see `_/env.ts`): constructing
 * the client at module scope would make every offline tool that imports the
 * Elysia app fail at import time on a machine with no Clerk credentials.
 *
 * Memoised, because `createClerkClient` builds a JWKS cache. The transport is
 * stateless and creates a fresh `McpServer` per POST; the token verifier is the
 * one thing that must *not* be per-request, or every request refetches Clerk's
 * signing keys.
 */
let cached: ClerkClient | null = null;

/** `null` when `CLERK_SECRET_KEY` is unset — the caller decides what that means. */
export function getClerkClient(): ClerkClient | null {
  const secretKey = env.CLERK_SECRET_KEY;
  if (!secretKey) return null;
  cached ??= createClerkClient({ secretKey, publishableKey: env.CLERK_PUBLISHABLE_KEY });
  return cached;
}
