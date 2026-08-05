import type { EpicNode, StreamNode, TaskNode } from "~/server/board";

/**
 * How the API's closed scalars are shown to a human: the three status
 * vocabularies, and the timestamps.
 *
 * The type-only import above is erased at compile time, so this module pulls in
 * no server code at runtime and stays safe to use from client components.
 */

/**
 * The four tones the ported `data-tone` CSS styles, plus the neutral default.
 *
 * `styles.css` is byte-identical to `apps/legacy project`'s and stays that way, so the
 * palette is the settled one rather than a second copy free to drift. zpecs'
 * vocabularies are larger than legacy project's, which is why statuses map onto these
 * four rather than each getting a colour of its own.
 */
export type Tone = "in_progress" | "blocked" | "done" | "none";

export interface Vocabulary<Member extends string> {
  /** Every member, in the order declared below — the status ladder. */
  readonly values: readonly Member[];
  readonly toneOf: (member: Member) => Tone;
}

/**
 * Declares one vocabulary as an exhaustive map from the API's own union to the
 * tone each member renders as.
 *
 * `Record<Member, Tone>` is what makes this safe in **both** directions: a
 * member the API gained but this file has not listed is a missing key, and a
 * member the API cannot send is an excess property. Both are compile errors, so
 * the brief's rule — a status the UI silently drops is invisible work — is
 * mechanical rather than a promise.
 *
 * `values` comes from `Object.keys`, whose order for non-numeric string keys is
 * the declaration order in the literal below.
 */
function vocabulary<Member extends string>(tones: Record<Member, Tone>): Vocabulary<Member> {
  return {
    // `Object.keys` is typed `string[]` regardless of its argument, so this is
    // the standard widen-then-narrow. It is sound here for the reason the
    // signature already guarantees: the keys of a `Record<Member, Tone>` are
    // exactly `Member`.
    values: Object.keys(tones) as unknown as readonly Member[],
    toneOf: (member) => tones[member],
  };
}

/**
 * An epic is a long-lived capability rather than a container, so it deliberately
 * has no `done`: finishing one of its streams does not finish the epic.
 */
export const epicStatus = vocabulary<EpicNode["status"]>({
  active: "in_progress",
  paused: "none",
  archived: "none",
});

/** The stream maturity ladder, in order. */
export const streamStatus = vocabulary<StreamNode["status"]>({
  draft: "none",
  planned: "none",
  ready: "none",
  in_progress: "in_progress",
  blocked: "blocked",
  completed: "done",
  cancelled: "none",
});

/**
 * A task has an `in_review` stage a stream does not, and reaches `done` rather
 * than `completed`. `in_review` is toned as in-flight: it is work under way, not
 * work finished.
 */
export const taskStatus = vocabulary<TaskNode["status"]>({
  draft: "none",
  ready: "none",
  in_progress: "in_progress",
  blocked: "blocked",
  in_review: "in_progress",
  done: "done",
  cancelled: "none",
});

export type EpicStatus = EpicNode["status"];
export type StreamStatus = StreamNode["status"];
export type TaskStatus = TaskNode["status"];

/**
 * Turns a `snake_case` domain value into a label.
 *
 * Computed rather than looked up in a map on purpose: a lookup can be missing an
 * entry and fall back to a dash, which is how `in_review` would silently become
 * "—". Every member of every vocabulary gets a readable label here, including
 * the stream and task *types*, which are rendered per row and never enumerated.
 */
export function label(value: string): string {
  const spaced = value.replaceAll("_", " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Formats one of the API's ISO-8601 timestamps.
 *
 * The parameter is a `string` and really is one at runtime, because the Treaty
 * client sets `parseDate: false`. Without that, Treaty would hand this function
 * a `Date` while the type still claimed `string`. An unparseable value renders
 * as a dash rather than "Invalid Date".
 */
export function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
