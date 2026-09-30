import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

function isLoopbackHostname(hostname: string) {
  if (hostname === "localhost" || hostname === "[::1]") return true;

  const octets = hostname.split(".");
  return (
    octets.length === 4 &&
    octets[0] === "127" &&
    octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
  );
}

function isCanonicalOrigin(value: string) {
  try {
    return new URL(value).origin === value;
  } catch {
    return false;
  }
}

function hasAllowedPublicProtocol(value: string) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" || (url.protocol === "http:" && isLoopbackHostname(url.hostname))
    );
  } catch {
    return false;
  }
}

const publicUrlSchema = z
  .url()
  .refine(isCanonicalOrigin, {
    message: "must be a canonical origin without a trailing slash, path, query, or fragment",
  })
  .refine(hasAllowedPublicProtocol, {
    message: "must use HTTPS unless the hostname is localhost, 127.0.0.0/8, or [::1]",
  });

function configured(value: string | undefined) {
  return value === undefined || value === "" ? undefined : value;
}

const genericPublishableKey = configured(process.env.CLERK_PUBLISHABLE_KEY);
const vitePublishableKey = configured(process.env.VITE_CLERK_PUBLISHABLE_KEY);

if (
  genericPublishableKey !== undefined &&
  vitePublishableKey !== undefined &&
  genericPublishableKey !== vitePublishableKey
) {
  throw new Error(
    "CLERK_PUBLISHABLE_KEY and VITE_CLERK_PUBLISHABLE_KEY are both set but do not match",
  );
}

export const env = createEnv({
  server: {
    DATABASE_URL: z.url(),
    // The one externally visible origin used in OAuth resource identifiers and
    // discovery URLs. It must never be inferred from proxy-controlled headers.
    SPEC_PUBLIC_URL: publicUrlSchema,
    // The only Clerk variable the `.well-known` handlers need (api/mcp/wellKnown.ts).
    // Clerk's Frontend API domain is never configured directly — it is derived
    // from this key the same way Clerk's own (uninstallable here, see
    // global-constraints.md) `@clerk/mcp-tools` package derives it, so a
    // separately-configured domain can never drift from the key. Optional so
    // offline tooling can boot without Clerk credentials; the `.well-known`
    // routes fail per-request (not at boot) when it is unset.
    // VITE_CLERK_PUBLISHABLE_KEY is canonical in the merged web host. The
    // generic name remains accepted for offline tools and library consumers.
    CLERK_PUBLISHABLE_KEY: z
      .string()
      .regex(/^pk_(test|live)_/, "must start with pk_test_ or pk_live_")
      .optional(),
    // Verifies the bearer token on `POST /mcp` (integration/clerk/client.ts).
    // Optional for the same reason as the publishable key: offline tooling must
    // still boot without Clerk credentials. A request that needs it
    // while it is unset answers 500 `clerk_not_configured` — never 401, which
    // would send the client into an OAuth flow that cannot succeed.
    CLERK_SECRET_KEY: z
      .string()
      .regex(/^sk_(test|live)_/, "must start with sk_test_ or sk_live_")
      .optional(),
  },
  runtimeEnv: {
    ...process.env,
    DATABASE_URL: process.env.SPEC_DATABASE_URL || process.env.DATABASE_URL,
    CLERK_PUBLISHABLE_KEY: genericPublishableKey ?? vitePublishableKey,
  },
  emptyStringAsUndefined: true,
});
