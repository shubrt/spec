import { asText, contentOf, type JsonObject } from "~/lib/document";
import type { EpicStatus, StreamStatus } from "~/lib/vocabulary";
import type { EpicNode } from "~/server/board";

/**
 * Client-side filtering and sorting of the epic list.
 *
 * All of it runs over the one aggregate the root loader already holds. The MVP
 * deliberately does not paginate or server-filter, so typing in the search box
 * must not cost a round trip — which also means this module, not the API, owns
 * what "matches" means and keeps that decision in one place.
 */

/** The filter value that applies no constraint. Not a status, so it cannot collide with one. */
export const ANY_STATUS = "all";

export type EpicStatusFilter = EpicStatus | typeof ANY_STATUS;
export type StreamStatusFilter = StreamStatus | typeof ANY_STATUS;
export type EpicSort = "default" | "title";

export interface EpicCriteria {
  /** Free text. Trimmed and case-folded here, so the caller can pass the raw input. */
  readonly query: string;
  readonly epicStatus: EpicStatusFilter;
  readonly streamStatus: StreamStatusFilter;
  readonly sort: EpicSort;
}

export const NO_CRITERIA: EpicCriteria = {
  query: "",
  epicStatus: ANY_STATUS,
  streamStatus: ANY_STATUS,
  sort: "default",
};

/**
 * The text a free-text query searches within one entity.
 *
 * `key` is included because `E-3` is how a person refers to an epic in
 * conversation, and `purpose` because the title alone is rarely enough to find
 * something again a week later.
 */
function entityText(entity: {
  readonly title: string;
  readonly key: string;
  readonly summary: string | null;
  readonly document: JsonObject;
}): string {
  return [
    entity.title,
    entity.key,
    entity.summary ?? "",
    asText(contentOf(entity.document).purpose),
  ]
    .join(" ")
    .toLowerCase();
}

/**
 * Narrows the epic list and the streams nested beneath each epic.
 *
 * The rule, stated once for every caller:
 *
 * - the epic-status filter drops whole epics;
 * - the stream-status filter drops streams, and then any epic left with none;
 * - a query keeps a stream if the stream matches it **or its epic does**, so
 *   searching for an epic shows you what is inside it rather than an empty row;
 * - an epic with no streams at all survives a query it matches itself, but not a
 *   stream-status filter — nothing beneath it can satisfy that.
 *
 * Returns fresh epic objects with a narrowed `streams` array; the input is never
 * mutated, because it is the loader's cached aggregate.
 */
export function filterEpics(epics: readonly EpicNode[], criteria: EpicCriteria): EpicNode[] {
  const query = criteria.query.trim().toLowerCase();

  const kept = epics
    .filter((epic) => criteria.epicStatus === ANY_STATUS || epic.status === criteria.epicStatus)
    .map((epic) => {
      const epicMatches = query === "" || entityText(epic).includes(query);
      const streams = epic.streams.filter(
        (stream) =>
          (criteria.streamStatus === ANY_STATUS || stream.status === criteria.streamStatus) &&
          (epicMatches || entityText(stream).includes(query)),
      );
      return { epic, streams, epicMatches };
    })
    .filter(
      ({ streams, epicMatches }) =>
        streams.length > 0 || (criteria.streamStatus === ANY_STATUS && epicMatches),
    )
    .map(({ epic, streams }) => ({ ...epic, streams }));

  // "default" is the server's order, which is creation order at every level.
  // Sorting by key would read as wrong: keys go E-1 … E-10 and sort
  // lexicographically, so E-10 would land between E-1 and E-2.
  return criteria.sort === "title"
    ? [...kept].sort((left, right) => left.title.localeCompare(right.title))
    : kept;
}
