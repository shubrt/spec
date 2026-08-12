import type { RevisionPage } from "~/server/revisions";
import { isoDay } from "./vocabulary";

/**
 * The revision log, as the Changes screen reads it.
 *
 * The server has already diffed, filtered and cut the page — see
 * `domain/service/revisionLog.ts` — so this file only adds what a row needs to be
 * addressable in the table and in the URL.
 *
 * One table, not one per day. Grouping by day cut the log into several tables with
 * several paginations and several sort states, so a range crossing midnight could
 * not be read in order. The day is a column now and the range lives in the filter.
 */

/** One revision as the server projected it, plus the two derived fields below. */
export type RevisionEntry = RevisionPage["revisions"][number] & {
  /** `YYYY-MM-DD`, so a date input can compare against it. */
  readonly day: string;
  /** Unique per row: an entity plus a revision number is exactly one revision. */
  readonly key: string;
};

export function toRevisionEntries(page: RevisionPage): readonly RevisionEntry[] {
  return page.revisions.map((entry) => ({
    ...entry,
    day: isoDay(entry.createdAt),
    key: `${entry.entityKey}@${String(entry.revision)}`,
  }));
}
