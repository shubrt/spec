import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

// Server-only environment, imported only from src/start.ts and src/server/*.
//
// There is deliberately no DATABASE_URL here, unlike apps/legacy project: this app owns
// no database connection. Every read goes to @zpecs/api over HTTP, so the tenant
// filter and the read-only guarantee live in exactly one place.
export const env = createEnv({
  server: {
    // Clerk's request middleware and server helpers would read this straight
    // from process.env. Declaring it means a missing or malformed key fails
    // once at boot with a readable message, rather than surfacing as an opaque
    // Clerk error on the first authenticated request.
    CLERK_SECRET_KEY: z.string().regex(/^sk_(test|live)_/, "must start with sk_test_ or sk_live_"),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});
