import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
  server: {
    DATABASE_URL: z.url(),
    // 3001 = zpecs.api, 3002 = legacy project, 3003 = web (reserved), 3004 = zpecs web service.
    // Lives here rather than in apps/web because that package is a thin
    // launcher — libs/api is "all code", including its own config schema.
    PORT: z.coerce.number().int().positive().default(3004),
    AXIOM_DATASET: z.string().min(1).optional(),
    AXIOM_TOKEN: z.string().min(1).optional(),
    // The only Clerk variable the `.well-known` handlers need (api/mcp/wellKnown.ts).
    // Clerk's Frontend API domain is never configured directly — it is derived
    // from this key the same way Clerk's own (uninstallable here, see
    // global-constraints.md) `@clerk/mcp-tools` package derives it, so a
    // separately-configured domain can never drift from the key. Optional so
    // offline/DB tests that carry no Clerk credentials still boot; the
    // `.well-known` routes fail per-request (not at boot) when it is unset.
    CLERK_PUBLISHABLE_KEY: z
      .string()
      .regex(/^pk_(test|live)_/, "must start with pk_test_ or pk_live_")
      .optional(),
    // Verifies the bearer token on `POST /mcp` (integration/clerk/client.ts).
    // Optional for the same reason as the publishable key: offline and DB tests
    // carry no Clerk credentials and must still boot. A request that needs it
    // while it is unset answers 500 `clerk_not_configured` — never 401, which
    // would send the client into an OAuth flow that cannot succeed.
    CLERK_SECRET_KEY: z
      .string()
      .regex(/^sk_(test|live)_/, "must start with sk_test_ or sk_live_")
      .optional(),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});
