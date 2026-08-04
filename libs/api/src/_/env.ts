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
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});
