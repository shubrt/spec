import type { RevisionLog } from "~/server/revisions";
import { isoDay } from "./vocabulary";

/**
 * The revision log, as the Changes screen reads it.
 *
 * The server already computed the diff — see `domain/service/revisionLog.ts` — so
 * this file only adds what a filter needs: a comparable day, and a stable row key.
 *
 * One table, not one per day. Grouping by day cut the log into several tables with
 * several paginations and several sort states, so a range crossing midnight could
 * not be read in order. The day is a column now and the range lives in the filter.
 */

/** One revision as the server projected it, plus the two derived fields below. */
export type RevisionEntry = RevisionLog[number] & {
  /** `YYYY-MM-DD`, so a date input can compare against it. */
  readonly day: string;
  /** Unique per row: an entity plus a revision number is exactly one revision. */
  readonly key: string;
};

export function toRevisionEntries(log: RevisionLog): readonly RevisionEntry[] {
  return log.map((entry) => ({
    ...entry,
    day: isoDay(entry.createdAt),
    key: `${entry.entityKey}@${String(entry.revision)}`,
  }));
}

export interface RevisionFilters {
  readonly from?: string;
  readonly to?: string;
  readonly type?: string;
  readonly kind?: string;
  readonly actor?: string;
  readonly entity?: string;
}

export function applyRevisionFilters(
  entries: readonly RevisionEntry[],
  filters: RevisionFilters,
): readonly RevisionEntry[] {
  return entries.filter((entry) => {
    if (filters.from && entry.day < filters.from) return false;
    if (filters.to && entry.day > filters.to) return false;
    if (filters.type && entry.entityType !== filters.type) return false;
    if (filters.kind && entry.kind !== filters.kind) return false;
    if (filters.actor && entry.changedBy !== filters.actor) return false;
    if (filters.entity && entry.entityKey !== filters.entity) return false;
    return true;
  });
}

/** Every actor that has written a revision, with how many. Two exist in practice. */
export function actorTally(
  entries: readonly RevisionEntry[],
): readonly { readonly actor: string; readonly count: number }[] {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    counts.set(entry.changedBy, (counts.get(entry.changedBy) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([actor, count]) => ({ actor, count }))
    .sort((left, right) => right.count - left.count);
}

/**
 * How many distinct recorded reasons stand behind these revisions.
 *
 * Worth stating because the two numbers differ a lot: one reason routinely rewrites
 * several entities at once. The screen says so rather than collapsing them, since
 * the database stores no batch to collapse them into.
 */
export function reasonCount(entries: readonly RevisionEntry[]): number {
  return new Set(entries.flatMap((entry) => (entry.changeReason ? [entry.changeReason] : []))).size;
}
