import type { WorkspaceScope } from "../auth/workspaceScope";
import type { VersionedEntityType } from "../enums";
import type { DbExecutor } from "../repository/entity";
import { type SearchHitRow, searchRepository } from "../repository/search";

/**
 * `search_context`'s service layer (plan task B15).
 *
 * ## Why the hits are this small
 *
 * A hit is six short strings, including its project qualifier. That is the whole point of having `search_context`
 * and `get_context` as two tools: search is what a model uses to *scan*, so it must
 * be able to look at twenty hits without spending its context, and `get_context` is
 * what it uses to *read* one of them. A search that returned whole documents would
 * make `get_context` pointless and would blow the model's context every turn.
 *
 * ## Why `matching` is on the result
 *
 * When exact matching finds nothing the fallback returns approximate hits, and the
 * model has to be told which of the two it is looking at — otherwise "close enough
 * on the spelling" is indistinguishable from "this is what you asked for", and an
 * agent will act on a neighbouring stream. It also keeps the fallback observable
 * at the service boundary without exposing repository details.
 */

/** One compact hit. Deliberately six short fields — see the file comment. */
export type SearchHit = {
  /** Project qualifier required because E/S/T/M/R keys are only project-scoped. */
  readonly project: string;
  readonly key: string;
  /** The entity's title, as denormalised onto the row. */
  readonly title: string;
  /**
   * Entity kind, plus the Stream or Task type after a colon: `rule`,
   * `stream:feature`, `task:implementation`. One field rather than two because it
   * is what an agent reads to decide whether a hit is worth a `get_context`, and
   * two fields would be two things to line up.
   */
  readonly type: string;
  readonly status: string;
  /** Matching text with the matched words in `**bold**`. Never the whole document. */
  readonly snippet: string;
};

export type SearchContextInput = {
  readonly query: string;
  readonly entity?: VersionedEntityType;
  readonly projectId?: string;
  /** Clamped into `[1, MAX_SEARCH_LIMIT]`; omitted means `DEFAULT_SEARCH_LIMIT`. */
  readonly limit?: number;
};

export type SearchContextResult = {
  readonly hits: readonly SearchHit[];
  /**
   * `exact` — the words are in the documents. `fuzzy` — they are not, and these are
   * the closest names found instead.
   */
  readonly matching: "exact" | "fuzzy";
};

export const DEFAULT_SEARCH_LIMIT = 20;
export const MAX_SEARCH_LIMIT = 50;

const clampLimit = (limit: number | undefined): number => {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DEFAULT_SEARCH_LIMIT;
  }
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_SEARCH_LIMIT);
};

const toHit = (row: SearchHitRow): SearchHit => ({
  project: row.project,
  key: row.key,
  title: row.title,
  type: row.subtype === null ? row.entity : `${row.entity}:${row.subtype}`,
  status: row.status,
  snippet: row.snippet,
});

async function searchContext(
  scope: WorkspaceScope,
  input: SearchContextInput,
  executor?: DbExecutor,
): Promise<SearchContextResult> {
  const query = input.query.trim();
  // An empty query matches nothing under `websearch_to_tsquery` and would send the
  // fallback into a whole-tenant trigram scan for a result that is empty by
  // definition. Answering it without touching the database is not an optimisation,
  // it is the only correct handling.
  if (query === "") {
    return { hits: [], matching: "exact" };
  }

  const options = {
    query,
    entity: input.entity,
    projectId: input.projectId,
    limit: clampLimit(input.limit),
  };

  const exact = await searchRepository.search(scope, options, executor);
  if (exact.length > 0) {
    return { hits: exact.map(toHit), matching: "exact" };
  }

  const fuzzy = await searchRepository.searchFuzzy(scope, options, executor);
  return { hits: fuzzy.map(toHit), matching: fuzzy.length > 0 ? "fuzzy" : "exact" };
}

export const searchService = { searchContext };
