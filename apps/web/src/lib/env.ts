import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export function isLoopbackHostname(hostname: string) {
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

const publicOrigin = z
  .url()
  .refine(isCanonicalOrigin, {
    message: "must be a canonical origin without a trailing slash, path, query, or fragment",
  })
  .refine(hasAllowedPublicProtocol, {
    message: "must use HTTPS unless the hostname is localhost, 127.0.0.0/8, or [::1]",
  });

// Server-only environment for the unified TanStack + Elysia process. The
// browser still receives only variables explicitly consumed through Vite.
export const env = createEnv({
  server: {
    DATABASE_URL: z.url(),
    // Canonical origin of the unified process. It is used for MCP resource and
    // discovery URLs and must never be inferred from proxy-controlled headers.
    SPEC_PUBLIC_URL: publicOrigin,
    // Canonical Clerk publishable key for this app. The shared API maps this to
    // its compatibility name when it builds OAuth discovery metadata.
    VITE_CLERK_PUBLISHABLE_KEY: z
      .string()
      .regex(/^pk_(test|live)_/, "must start with pk_test_ or pk_live_"),
    // Clerk's request middleware and server helpers would read this straight
    // from process.env. Declaring it means a missing or malformed key fails
    // once at boot with a readable message, rather than surfacing as an opaque
    // Clerk error on the first authenticated request.
    CLERK_SECRET_KEY: z.string().regex(/^sk_(test|live)_/, "must start with sk_test_ or sk_live_"),
    AXIOM_DATASET: z.string().min(1).optional(),
    AXIOM_TOKEN: z.string().min(1).optional(),
  },
  runtimeEnv: {
    ...process.env,
    DATABASE_URL: process.env.SPEC_DATABASE_URL || process.env.DATABASE_URL,
    AXIOM_DATASET: process.env.SPEC_AXIOM_DATASET || process.env.AXIOM_DATASET,
    AXIOM_TOKEN: process.env.SPEC_AXIOM_TOKEN || process.env.AXIOM_TOKEN,
  },
  emptyStringAsUndefined: true,
});
