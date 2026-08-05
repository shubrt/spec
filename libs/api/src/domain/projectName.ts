import { z } from "zod";

/**
 * Project names are user-facing identifiers inside a workspace.
 *
 * Keep this schema at the domain boundary so the browser-session endpoint and
 * the operator bootstrap command cannot drift. The transform is intentional:
 * callers receive the canonical value that is safe to persist, rather than
 * having to remember to trim after validation.
 */
export const projectNameSchema = z
  .string({ error: "Project name is required" })
  .trim()
  .min(1, "Project name must contain at least one non-whitespace character")
  .max(120, "Project name must be at most 120 characters");

export type ProjectName = z.infer<typeof projectNameSchema>;
