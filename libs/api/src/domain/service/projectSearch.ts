import type { WorkspaceScope } from "../auth/workspaceScope";
import { epicRepository } from "../repository/epic";
import { milestoneRepository } from "../repository/milestone";
import { ruleRepository } from "../repository/rule";
import { streamRepository } from "../repository/stream";
import { taskRepository } from "../repository/task";
import { fragmentText, loadFragmentPage } from "./projectFragments";
import { asText, contentOf } from "./documentValue";

/**
 * Project search, with the ranking rule on every hit.
 *
 * ## Why this exists beside `service/search.ts`
 *
 * That one backs the MCP `search_context` tool: five short fields per hit, capped
 * low, so a model can scan without spending its context. It is also entity-level and
 * — until the generated columns were widened — matched only title and summary.
 *
 * This one answers a different question. The web overlay shows *where* a match is:
 * grouped by kind, with the parent trail, and with fragment hits carrying their
 * anchor, because `AC-2` on its own identifies nothing. It also names the rule each
 * row matched on, which is the part that makes the ordering checkable — a fuzzy hit
 * sitting above a title match looks like a bug unless the row says which it is.
 *
 * ## Why the ranking is here and not in SQL
 *
 * The six rules are ordinal over fields the browser used to have in hand: exact key,
 * key prefix, title starts, title contains, body contains, then a tight fuzzy. A
 * `ts_rank` would replace all six with one opaque float and the rows could no longer
 * say what they matched. Postgres full-text remains the right tool for *finding*
 * candidates in a large corpus; it is the wrong tool for explaining an order to a
 * human. At this corpus size the whole project is read and ranked here.
 */

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

const NO_MATCH = 99;

export const SEARCH_RESULT_CAP = 60;

export interface SearchHit {
  /** The key to open. For a fragment this is its owner, which is what has a page. */
  readonly target: string;
  /** What is printed: a key, or `S-46#CHG-1` for a fragment. */
  readonly display: string;
  readonly group: SearchGroup;
  readonly title: string;
  readonly kind: string;
  /** Where it sits, so a key is never shown without its context. */
  readonly path: string;
  readonly status: string | null;
  readonly excerpt: string | null;
  readonly score: number;
  readonly rankLabel: string;
}

export interface SearchResult {
  readonly hits: readonly SearchHit[];
  /** Matches before the cap. Stated on screen rather than silently dropped. */
  readonly total: number;
  readonly cap: number;
  /** Everything searchable, so the empty state can say how big the corpus is. */
  readonly indexed: number;
}

export interface SearchInput {
  readonly query: string;
  readonly limit?: number;
}

/**
 * A subsequence spread across a whole sentence is not a typo, it is noise —
 * "dependency" would otherwise match half the corpus. Only a span tight enough to be
 * a misspelling counts.
 */
function fuzzy(haystack: string, needle: string): boolean {
  let index = 0;
  let start = -1;
  let end = -1;
  for (let position = 0; position < haystack.length && index < needle.length; position += 1) {
    if (haystack[position] === needle[index]) {
      if (start < 0) start = position;
      end = position;
      index += 1;
    }
  }
  return index === needle.length && end - start < needle.length * 2;
}

type Candidate = Omit<SearchHit, "score" | "rankLabel">;

function rank(candidate: Candidate, query: string): number {
  const target = candidate.target.toLowerCase();
  const display = candidate.display.toLowerCase();
  const title = candidate.title.toLowerCase();
  const excerpt = (candidate.excerpt ?? "").toLowerCase();

  if (target === query || display === query) return 0;
  if (target.startsWith(query) || display.startsWith(query)) return 1;
  if (title.startsWith(query)) return 2;
  if (title.includes(query)) return 3;
  if (excerpt.includes(query)) return 4;
  if (query.length >= 3 && fuzzy(title, query)) return 5;
  return NO_MATCH;
}

export async function searchProject(
  scope: WorkspaceScope,
  projectId: string,
  input: SearchInput,
): Promise<SearchResult> {
  const query = input.query.trim().toLowerCase();
  const cap = Math.min(Math.max(input.limit ?? SEARCH_RESULT_CAP, 1), 200);

  const [epics, streams, tasks, milestones, rules, fragmentPage, project] = await Promise.all([
    epicRepository.listByProject(scope, projectId),
    streamRepository.listByProject(scope, projectId),
    taskRepository.listByProject(scope, projectId),
    milestoneRepository.listByProject(scope, projectId),
    ruleRepository.listByProject(scope, projectId),
    // The whole fragment set: `limit` is the *result* cap, not a corpus cap, and a
    // search that only looked at the first page of fragments would be a lie.
    loadFragmentPage(scope, projectId, { offset: 0, limit: Number.MAX_SAFE_INTEGER }),
    Promise.resolve(projectId),
  ]);
  void project;

  const epicKeyById = new Map(epics.map((row) => [row.id, row.key]));
  const streamKeyById = new Map(streams.map((row) => [row.id, row.key]));

  const candidates: Candidate[] = [
    ...epics.map((row) => ({
      target: row.key,
      display: row.key,
      group: "Epics" as const,
      title: row.title,
      kind: "epic",
      path: "",
      status: row.status,
      excerpt: row.summary ?? asText(contentOf(row.document).purpose),
    })),
    ...streams.map((row) => ({
      target: row.key,
      display: row.key,
      group: "Streams" as const,
      title: row.title,
      kind: row.streamType,
      path: epicKeyById.get(row.epicId) ?? "",
      status: row.status,
      excerpt: asText(contentOf(row.document).purpose) || row.summary,
    })),
    ...tasks.map((row) => ({
      target: row.key,
      display: row.key,
      group: "Tasks" as const,
      title: row.title,
      kind: row.taskType,
      path: streamKeyById.get(row.streamId) ?? "",
      status: row.status,
      excerpt: asText(contentOf(row.document).objective) || row.summary,
    })),
    ...milestones.map((row) => ({
      target: row.key,
      display: row.key,
      group: "Milestones" as const,
      title: row.title,
      kind: "milestone",
      path: "",
      status: row.status,
      excerpt: asText(contentOf(row.document).goal) || row.summary,
    })),
    ...rules.map((row) => ({
      target: row.key,
      display: row.key,
      group: "Rules" as const,
      title: row.title,
      kind: "rule",
      path: "",
      status: row.status,
      excerpt: asText(contentOf(row.document).statement) || row.summary,
    })),
    // A fragment's target is its owner: the fragment has no page of its own, and
    // opening the entity that holds it is the only honest destination.
    ...fragmentPage.fragments.map((entry) => ({
      target: entry.owner,
      display: entry.anchor,
      group: "Spec fragments" as const,
      title: fragmentText(entry),
      kind: entry.section,
      path: entry.owner,
      status: null,
      excerpt: fragmentText(entry),
    })),
  ];

  if (query.length === 0) {
    return { hits: [], total: 0, cap, indexed: candidates.length };
  }

  const scored: SearchHit[] = [];
  for (const candidate of candidates) {
    const score = rank(candidate, query);
    if (score === NO_MATCH) continue;
    scored.push({ ...candidate, score, rankLabel: RANK_LABEL[score] ?? "match" });
  }

  scored.sort(
    (left, right) =>
      left.score - right.score ||
      SEARCH_GROUPS.indexOf(left.group) - SEARCH_GROUPS.indexOf(right.group) ||
      left.display.localeCompare(right.display),
  );

  return {
    hits: scored.slice(0, cap),
    total: scored.length,
    cap,
    indexed: candidates.length,
  };
}
