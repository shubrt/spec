import { severitySchema, statement, statementList } from "../primitives";
import { ruleText } from "../rules";
import { streamBaseContent } from "./base";

/**
 * A `bug` stream: fix wrong behaviour (domain spec §3.2, §6).
 *
 * The three added sections are exactly the ones the domain spec names —
 * reproduction, actual behaviour, expected behaviour — and deliberately *not* a
 * user story. Domain spec §14 forbids "eine künstliche User-Story-Struktur für
 * Bugs": a bug is not "as a user I want…", it is "this happens, that should
 * happen, here is how to see it".
 *
 * All three are structurally optional because domain spec §11 qualifies the rule
 * with "sofern bekannt" — a bug report often starts with only a symptom. The
 * obligation lands at readiness instead: a bug at `ready` or beyond must have
 * both behaviours, enforced by `readiness.ts`.
 */

export const bugStreamContent = streamBaseContent.extend({
  reproduction: statementList.optional().meta({
    description: "Ordered steps that reproduce the defect, specific enough to follow verbatim.",
  }),
  actual_behavior: statement
    .optional()
    .meta({ description: ruleText("ready_bug_needs_actual_and_expected_behavior") }),
  expected_behavior: statement
    .optional()
    .meta({ description: ruleText("ready_bug_needs_actual_and_expected_behavior") }),
  severity: severitySchema.optional(),
});
