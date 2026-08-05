import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

// Server-only environment, imported only from src/start.ts and src/server/*.
//
// There is deliberately no DATABASE_URL here, unlike apps/legacy project: this app owns
// no database connection. Aggregate reads and the one project-container write go
// to @zpecs/api over HTTP, so tenant scoping lives in exactly one place. Epic,
// stream and task writes remain MCP-only.
export const env = createEnv({
  server: {
    // Origin of @zpecs/api. Deliberately not VITE_-prefixed: keeping it off
    // import.meta.env is what stops the browser reaching the API directly,
    // which would put a session-authenticated multi-tenant surface behind CORS
    // instead of behind this app's server functions.
    // 3001 = zpecs.api, 3002 = legacy project, 3003 = web, 3004 = zpecs web service.
    ZPECS_API_URL: z.url().default("http://localhost:3004"),
    // Clerk's request middleware and server helpers would read this straight
    // from process.env. Declaring it means a missing or malformed key fails
    // once at boot with a readable message, rather than surfacing as an opaque
    // Clerk error on the first authenticated request.
    CLERK_SECRET_KEY: z.string().regex(/^sk_(test|live)_/, "must start with sk_test_ or sk_live_"),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});
