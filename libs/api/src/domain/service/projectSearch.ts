import type { WorkspaceScope } from "../auth/workspaceScope";
import { searchProjectCandidates } from "../repository/projectWebSearch";

/** Search groups appear in this fixed order inside an equal rank. */
export const SEARCH_GROUPS = [
  "Epics",
  "Streams",
  "Tasks",
  "Milestones",
  "Rules",
  "Spec fragments",
] as const;

export type SearchGroup = (typeof SEARCH_GROUPS)[number];

export const RANK_LABEL = [
  "exact key",
  "key prefix",
  "title starts",
  "title match",
  "text match",
  "fuzzy",
] as const;

export const SEARCH_RESULT_CAP = 60;

export interface SearchHit {
  readonly target: string;
  readonly display: string;
  readonly group: SearchGroup;
  readonly title: string;
  readonly kind: string;
  readonly path: string;
  readonly status: string | null;
  readonly excerpt: string | null;
  readonly score: number;
  readonly rankLabel: string;
}

export interface SearchResult {
  readonly hits: readonly SearchHit[];
  readonly total: number;
  readonly cap: number;
  readonly indexed: number;
}

export interface SearchInput {
  readonly query: string;
  readonly limit?: number;
}

/**
 * Indexed, bounded web-overlay search.
 *
 * The database applies the same six explainable ordinal rules the old in-memory
 * search used, orders the union once, and transfers only the requested page. Exact
 * `total` and `indexed` counts travel with it so the UI's truncation and empty-state
 * copy remain honest without loading entity documents or the fragment corpus.
 */
export async function searchProject(
  scope: WorkspaceScope,
  projectId: string,
  input: SearchInput,
): Promise<SearchResult> {
  const query = input.query.trim().toLowerCase();
  const cap = Math.min(Math.max(input.limit ?? SEARCH_RESULT_CAP, 1), 200);
  if (query.length === 0) {
    const result = await searchProjectCandidates(scope, projectId, "", 0);
    return { hits: [], total: 0, cap, indexed: result.indexed };
  }

  const result = await searchProjectCandidates(scope, projectId, query, cap);
  return { hits: result.candidates, total: result.total, cap, indexed: result.indexed };
}
