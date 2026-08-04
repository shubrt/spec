import { z } from "zod";
import { scope, sectionId, statement } from "../primitives";
import { ruleText } from "../rules";
import { streamBaseContent } from "./base";

/**
 * An `investigation` stream: find out something unknown (domain spec §3.2).
 *
 * This is the type an agent must reach for when the user's request is a question
 * rather than a requirement — domain spec §13 spells that out ("Der Agent
 * erstellt keinen vorschnellen Feature-Plan, sondern einen `investigation`- oder
 * `experiment`-Stream"). Its whole purpose is to make "we do not know yet" a
 * first-class, writable state instead of a gap an agent fills with invention.
 *
 * Sections: `questions`, `discovery_scope`, `success_criteria` (all three from
 * the §8 investigation draft outline) and `expected_decision`.
 *
 * `discovery_scope` reuses the shared `scope` atom rather than defining its own
 * included/excluded pair: "what we will and will not look into" is the same shape
 * as "what the stream does and does not cover", and two copies would drift.
 */

/** One thing this investigation has to answer. Ids are join keys for the investigation tasks. */
export const investigationQuestion = z.strictObject({
  id: sectionId,
  question: statement,
  why_it_matters: statement.optional(),
});

/**
 * A measurable finish line for an investigation. Domain spec §11 allows this in
 * place of classic acceptance criteria — you cannot write given/when/then for a
 * question you have not answered yet.
 */
export const successCriterion = z.strictObject({
  id: sectionId,
  criterion: statement,
  measurement: statement.optional(),
});

export const investigationStreamContent = streamBaseContent.extend({
  questions: z.array(investigationQuestion).optional(),
  discovery_scope: scope.optional(),
  success_criteria: z
    .array(successCriterion)
    .optional()
    .meta({ description: ruleText("success_criteria_may_replace_acceptance_criteria") }),
  expected_decision: statement.optional().meta({
    description:
      "The decision this investigation must enable. An investigation that decides nothing should not be a stream.",
  }),
});
