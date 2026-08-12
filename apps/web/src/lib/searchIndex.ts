import { fragmentAnchor, sectionLabel } from "./fragments";
import type { ProjectModel } from "./model";
import type { EntityStatus } from "./vocabulary";

/**
 * The read-only search index, and how a hit is ranked.
 *
 * ## Every row names the rule it matched on
 *
 * `exact key`, `key prefix`, `title starts`, `title match`, `text match`, `fuzzy`.
 * Showing the rule is what makes the ordering checkable: a hit that arrived by fuzzy
 * match sitting above one that matched a title would otherwise look like a bug, and
 * a reader who cannot see why a result is first cannot tell a good ranking from a
 * random one.
 *
 * Groups follow their own best match rather than a fixed order, so a fuzzy Rule
 * never outranks an exact Stream key just because Rules are listed later.
 *
 * ## Navigation only
 *
 * No create, assign, status or bulk command. None of them exists on this surface,
 * and offering one in the place people reach for first would be the most misleading
 * spot possible.
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

export interface SearchItem {
  /** The key to open. For a fragment this is its owner, which is what has a page. */
  readonly target: string;
  /** What is printed on the left: a key, or `S-46#CHG-1` for a fragment. */
  readonly display: string;
  readonly group: SearchGroup;
  readonly title: string;
  readonly kind: string;
  /** Where it sits, so a key is never shown without its context. */
  readonly path: string;
  readonly status: EntityStatus | null;
  readonly blocked: boolean;
  readonly excerpt: string | null;
}

export function buildSearchIndex(model: ProjectModel): readonly SearchItem[] {
  const items: SearchItem[] = [];

  for (const epic of model.epics) {
    items.push({
      target: epic.key,
      display: epic.key,
      group: "Epics",
      title: epic.title,
      kind: "epic",
      path: model.projectName,
      status: epic.status,
      blocked: false,
      excerpt: epic.summary,
    });
  }

  for (const stream of model.streams) {
    items.push({
      target: stream.key,
      display: stream.key,
      group: "Streams",
      title: stream.title,
      kind: stream.streamType,
      path: `${model.projectName} / ${stream.epicKey} / ${stream.milestoneKey ?? "no Milestone"}`,
      status: stream.status,
      blocked: stream.dependency.kind === "blocked",
      excerpt: stream.purpose || stream.summary,
    });
  }

  for (const task of model.tasks) {
    items.push({
      target: task.key,
      display: task.key,
      group: "Tasks",
      title: task.title,
      kind: task.taskType,
      path: `${model.projectName} / ${task.epicKey} / ${task.streamKey}`,
      status: task.status,
      blocked: task.dependency.kind === "blocked" || task.streamBlocked,
      excerpt: task.objective || task.summary,
    });
  }

  for (const milestone of model.milestones) {
    items.push({
      target: milestone.key,
      display: milestone.key,
      group: "Milestones",
      title: milestone.title,
      kind: "milestone",
      path: model.projectName,
      status: milestone.status,
      blocked: false,
      excerpt: milestone.goal,
    });
  }

  for (const rule of model.rules) {
    items.push({
      target: rule.key,
      display: rule.key,
      group: "Rules",
      title: rule.title,
      kind: "rule",
      path: model.projectName,
      status: rule.status,
      blocked: false,
      excerpt: rule.statement,
    });
  }

  // A fragment is listed with its owner, because a local key like `AC-2` exists as
  // many times over as there are Streams with two criteria. `target` is the owner:
  // the fragment has no page of its own, and opening the entity that holds it is
  // the only honest destination.
  for (const fragment of model.fragments) {
    const owner = model.streamByKey.get(fragment.owner);
    items.push({
      target: fragment.owner,
      display: fragmentAnchor(fragment.owner, fragment.id),
      group: "Spec fragments",
      title: fragmentText(fragment),
      kind: sectionLabel(fragment.section),
      path: `${model.projectName} / ${fragment.owner}${owner ? ` · ${owner.title}` : ""}`,
      status: null,
      blocked: false,
      excerpt: fragmentText(fragment),
    });
  }

  return items;
}

/** The one searchable sentence of a fragment, whatever shape it is in. */
function fragmentText(fragment: ProjectModel["fragments"][number]): string {
  const { shape } = fragment;
  switch (shape.kind) {
    case "statement":
      return shape.text;
    case "criterion":
      return `${shape.given} · ${shape.when} · ${shape.then}`;
    case "condition":
      return `${shape.condition} → ${shape.outcome}`;
    case "transition":
      return `${shape.from} → ${shape.to}`;
    case "workflow":
      return shape.steps.map((step) => step.action).join(" · ");
  }
}

export const RANK_LABEL = [
  "exact key",
  "key prefix",
  "title starts",
  "title match",
  "text match",
  "fuzzy",
] as const;

const NO_MATCH = 99;

/**
 * A subsequence spread across a whole sentence is not a typo, it is noise —
 * "dependency" would otherwise match half the corpus. Only a span tight enough to
 * be a misspelling counts.
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

export function rankItem(item: SearchItem, query: string): number {
  const key = item.target.toLowerCase();
  const display = item.display.toLowerCase();
  const title = item.title.toLowerCase();
  const excerpt = (item.excerpt ?? "").toLowerCase();

  if (key === query || display === query) return 0;
  if (key.startsWith(query) || display.startsWith(query)) return 1;
  if (title.startsWith(query)) return 2;
  if (title.includes(query)) return 3;
  if (excerpt.includes(query)) return 4;
  if (query.length >= 3 && fuzzy(title, query)) return 5;
  return NO_MATCH;
}

export interface SearchHit extends SearchItem {
  readonly score: number;
  readonly rankLabel: string;
}

export interface SearchResults {
  readonly groups: readonly { readonly group: SearchGroup; readonly items: readonly SearchHit[] }[];
  readonly flat: readonly SearchHit[];
  readonly total: number;
  /** Rows past the cap. Stated on screen rather than silently dropped. */
  readonly truncated: number;
}

export const SEARCH_RESULT_CAP = 60;

export function searchProject(
  index: readonly SearchItem[],
  rawQuery: string,
): SearchResults | null {
  const query = rawQuery.trim().toLowerCase();
  if (query.length === 0) return null;

  const scored: SearchHit[] = [];
  for (const item of index) {
    const score = rankItem(item, query);
    if (score === NO_MATCH) continue;
    scored.push({ ...item, score, rankLabel: RANK_LABEL[score] ?? "match" });
  }
  scored.sort(
    (left, right) =>
      left.score - right.score ||
      SEARCH_GROUPS.indexOf(left.group) - SEARCH_GROUPS.indexOf(right.group) ||
      left.display.localeCompare(right.display),
  );

  const shown = scored.slice(0, SEARCH_RESULT_CAP);
  const best = (items: readonly SearchHit[]) =>
    items.reduce((min, item) => Math.min(min, item.score), NO_MATCH);

  const groups = SEARCH_GROUPS.flatMap((group) => {
    const items = shown.filter((hit) => hit.group === group);
    return items.length === 0 ? [] : [{ group, items }];
  }).sort(
    (left, right) =>
      best(left.items) - best(right.items) ||
      SEARCH_GROUPS.indexOf(left.group) - SEARCH_GROUPS.indexOf(right.group),
  );

  return {
    groups,
    flat: groups.flatMap((group) => group.items),
    total: scored.length,
    truncated: Math.max(0, scored.length - shown.length),
  };
}
