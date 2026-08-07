import { label, type Tone, type Vocabulary } from "~/lib/vocabulary";
import type { EpicNode, StreamNode, TaskNode } from "~/server/board";

/**
 * The derived numbers the project overview shows.
 *
 * Pure functions over the aggregate the root loader already holds — the API
 * exposes no counts, and asking it for any would be a second API call for
 * something the payload already answers.
 */

/** Every stream in the project, in the aggregate's own order. */
export function allStreams(epics: readonly EpicNode[]): StreamNode[] {
  return epics.flatMap((epic) => epic.streams);
}

/** Every task in the project, in the aggregate's own order. */
export function allTasks(epics: readonly EpicNode[]): TaskNode[] {
  return epics.flatMap((epic) => epic.streams.flatMap((stream) => stream.tasks));
}

export interface StatusCount<Member extends string = string> {
  readonly status: Member;
  readonly label: string;
  readonly tone: Tone;
  readonly count: number;
}

/**
 * Counts rows per status, over the **whole vocabulary**.
 *
 * Driven by the vocabulary rather than by the rows on purpose: counting only the
 * statuses that happen to occur would silently drop `blocked: 0`, and "nothing
 * is blocked" is exactly the fact a reader wants confirmed. Zero-count entries
 * are therefore kept, and the order is the vocabulary's — the status ladder.
 *
 * Taking the whole {@link Vocabulary} rather than just its values is what lets
 * the tone come out with the count, so the component rendering a breakdown never
 * has to work out which vocabulary a status came from.
 */
export function countByStatus<Member extends string>(
  rows: readonly { readonly status: string }[],
  vocabulary: Vocabulary<Member>,
): StatusCount<Member>[] {
  return vocabulary.values.map((status) => ({
    status,
    label: label(status),
    tone: vocabulary.toneOf(status),
    count: rows.filter((row) => row.status === status).length,
  }));
}

export interface Completion {
  readonly done: number;
  readonly total: number;
  readonly pct: number;
}

/**
 * Task completion.
 *
 * `done` is the only task status that counts as finished. `cancelled` work was
 * decided against rather than delivered, so folding it in would inflate the
 * number, and `in_review` is not finished until it is.
 */
export function taskCompletion(tasks: readonly TaskNode[]): Completion {
  const total = tasks.length;
  const done = tasks.filter((task) => task.status === "done").length;
  return { done, total, pct: total === 0 ? 0 : Math.round((done / total) * 100) };
}
