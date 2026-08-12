/**
 * Types the read surface shares with the web, and nothing else.
 *
 * **Type-only re-exports, deliberately.** The modules behind these types import
 * Drizzle and `pg`; a value import from this barrel would pull the database client
 * into a browser bundle. `export type` is erased at compile time, so the specifier
 * resolves for the type checker and disappears from the output.
 *
 * Separate from `_/index.ts` because that one exports the Elysia app and is a
 * server entry point. This one is safe to name from client code.
 */

export type {
  SectionId,
  SpecEvidence,
  SpecDetail,
  SpecFragmentModel,
  SpecMarks,
  SpecShape,
  SpecWorkflowStep,
  RuleApplicationModel,
  SourceModel,
} from "../domain/service/specFragment";
