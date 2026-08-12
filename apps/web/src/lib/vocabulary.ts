import type { EpicNode, MilestoneNode, RuleNode, StreamNode, TaskNode } from "~/server/board";

/**
 * How the API's closed scalars are shown to a human: the five status
 * vocabularies, the priority scale, and the timestamps.
 *
 * Every union here is projected off the API's own response type rather than
 * re-declared, so a value the server gains and this file has not handled is a
 * compile error instead of a blank cell. The type-only import is erased, so this
 * module pulls in no server code at runtime.
 */

export type EpicStatus = EpicNode["status"];
export type StreamStatus = StreamNode["status"];
export type TaskStatus = TaskNode["status"];
export type RuleStatus = RuleNode["status"];
export type MilestoneStatus = MilestoneNode["status"];
export type StreamType = StreamNode["streamType"];
export type TaskType = TaskNode["taskType"];

/** Every stored status any entity can carry. What `StatusCell` accepts. */
export type EntityStatus = EpicStatus | StreamStatus | TaskStatus | RuleStatus | MilestoneStatus;

/** `meta.priority`. Document-only — no column carries it. */
export const ENTITY_PRIORITY = ["critical", "high", "medium", "low"] as const;
export type EntityPriority = (typeof ENTITY_PRIORITY)[number];

/** `execution.executor_kind`. `either` is a real value; absence is not. */
export const EXECUTOR_KIND = ["human", "agent", "either"] as const;
export type ExecutorKind = (typeof EXECUTOR_KIND)[number];

/**
 * The status ladder of each vocabulary, in order.
 *
 * These exist so a breakdown can list every status including the ones with a
 * count of zero: "nothing is blocked" is exactly the fact a reader wants
 * confirmed, and a breakdown built only from the statuses present leaves them
 * guessing. Declared as exhaustive tuples so a new API value fails the build.
 */
export const EPIC_STATUS = [
  "active",
  "paused",
  "archived",
] as const satisfies readonly EpicStatus[];
export const STREAM_STATUS = [
  "draft",
  "planned",
  "ready",
  "in_progress",
  "blocked",
  "completed",
  "cancelled",
] as const satisfies readonly StreamStatus[];
export const TASK_STATUS = [
  "draft",
  "ready",
  "in_progress",
  "blocked",
  "in_review",
  "done",
  "cancelled",
] as const satisfies readonly TaskStatus[];
export const RULE_STATUS = [
  "draft",
  "active",
  "deprecated",
] as const satisfies readonly RuleStatus[];
export const MILESTONE_STATUS = [
  "draft",
  "planned",
  "active",
  "completed",
  "cancelled",
] as const satisfies readonly MilestoneStatus[];

export const STREAM_TYPE = [
  "feature",
  "bug",
  "change",
  "experiment",
  "investigation",
  "refactor",
  "maintenance",
] as const satisfies readonly StreamType[];

/**
 * A shape per status, so a Box still carries its meaning in a screenshot, on a
 * projector, or to a reader who cannot separate the green from the amber.
 */
const STATUS_MARKER: Record<EntityStatus, string> = {
  draft: "○",
  planned: "◇",
  ready: "▷",
  in_progress: "◐",
  blocked: "×",
  in_review: "‖",
  completed: "✓",
  done: "✓",
  cancelled: "/",
  active: "●",
  paused: "‖",
  archived: "—",
  deprecated: "—",
};

const STATUS_LABEL: Record<EntityStatus, string> = {
  draft: "Draft",
  planned: "Planned",
  ready: "Ready",
  in_progress: "In progress",
  blocked: "Blocked",
  in_review: "In review",
  completed: "Completed",
  done: "Done",
  cancelled: "Cancelled",
  active: "Active",
  paused: "Paused",
  archived: "Archived",
  deprecated: "Deprecated",
};

export function statusMarker(status: EntityStatus): string {
  return STATUS_MARKER[status];
}

/**
 * Narrows an arbitrary stored status, or `null` if this app has never heard of it.
 *
 * A revision carries the status as it stood at the time, read out of a snapshot
 * that may predate a schema change — so an unknown value is a legitimate historical
 * fact rather than a bug. The caller shows the raw string in that case instead of
 * forcing it into a vocabulary it does not belong to.
 */
export function asEntityStatus(value: string): EntityStatus | null {
  return value in STATUS_LABEL ? (value as EntityStatus) : null;
}

/**
 * A Stream reaches `completed` and a Task reaches `done`. Two different stored
 * values, so two different labels — collapsing them would hide that a Task and
 * its Stream finish on separate ladders.
 */
export function statusLabel(status: EntityStatus): string {
  return STATUS_LABEL[status];
}

/**
 * Ordering for a status column: work in flight first, then what could start,
 * then what is finished or abandoned.
 */
const STATUS_RANK: Record<EntityStatus, number> = {
  in_progress: 0,
  active: 0,
  ready: 1,
  in_review: 2,
  planned: 3,
  draft: 4,
  paused: 4,
  blocked: 5,
  completed: 6,
  done: 6,
  cancelled: 7,
  archived: 7,
  deprecated: 7,
};

export function statusRank(status: EntityStatus): number {
  return STATUS_RANK[status];
}

export function priorityRank(priority: EntityPriority | null): number {
  return priority === null ? ENTITY_PRIORITY.length : ENTITY_PRIORITY.indexOf(priority);
}

/**
 * Turns a `snake_case` domain value into a label.
 *
 * Computed rather than looked up, so a value this file has never seen — a stream
 * type, a verification method, a section name in a revision diff — still reads
 * as words instead of falling back to a dash.
 */
export function label(value: string): string {
  const spaced = value.replaceAll("_", " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** The numeric half of a project-scoped key: `S-12` → `12`. Sorts a key column. */
export function keySequence(key: string): number {
  const parsed = Number.parseInt(key.slice(key.indexOf("-") + 1), 10);
  return Number.isNaN(parsed) ? Number.MAX_SAFE_INTEGER : parsed;
}

/**
 * Formats one of the API's ISO-8601 timestamps as a revision timestamp.
 *
 * A revision timestamp is the only kind of time this product records: it says
 * when an entity was last rewritten. It is never a due date, a deadline or a
 * scheduled position, and no screen presents it as one.
 *
 * The parameter really is a `string` at runtime because the Treaty client sets
 * `parseDate: false`. An unparseable value renders as a dash rather than
 * "Invalid Date".
 */
export function formatRevisionTime(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** The date half only, for grouping and for a range filter. */
export function formatRevisionDate(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

/** `YYYY-MM-DD` in UTC, which is what a date input compares against. */
export function isoDay(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
}
