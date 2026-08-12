import type { ReactNode } from "react";
import { cn } from "~/lib/utils";
import type { EntityPriority, EntityStatus, ExecutorKind } from "~/lib/vocabulary";
import { statusLabel, statusMarker } from "~/lib/vocabulary";

/**
 * The Box, and the four categorical cells built from it.
 *
 * THE ONE BOX RULE. Every column is either categorical or quantitative, never
 * both:
 *
 *   Categorical  — Status, Blocked by, Executor, Priority.
 *                  EVERY cell is a Box of the same height, radius and padding,
 *                  absent values included, so a column never mixes boxed and
 *                  unboxed cells. A column of boxes with three gaps in it reads
 *                  as three failed loads.
 *
 *   Quantitative — counts, ranks, fractions, revisions. Plain right-aligned
 *                  mono, no box. Zero reads `0`; "none" belongs to a field that
 *                  holds nothing at all, which is a different statement.
 *
 * A status is rendered by {@link StatusCell} everywhere it appears — table,
 * drawer, revision diff — so Completed is the same green box with the same tick
 * wherever you meet it. Nothing else is allowed to draw a status.
 */

const BOX_BASE =
  "inline-flex h-[22px] w-fit shrink-0 items-center gap-1.5 whitespace-nowrap rounded-sm border px-2 text-xs";

/**
 * Nine tones. The four semantic ones use their `-soft` fill rather than the
 * saturated colour, because a Box holds 12 px text that has to be read.
 */
const BOX_TONE = {
  success: "border-success/40 bg-success-soft text-success font-medium",
  info: "border-info/40 bg-info-soft text-info font-medium",
  warning: "border-warning/45 bg-warning-soft text-warning font-medium",
  danger: "border-danger/50 bg-danger-soft text-danger font-semibold",
  neutral: "border-border-strong bg-background text-foreground",
  dashed: "border-dashed border-border-strong bg-background text-muted-foreground",
  quiet: "border-border bg-muted text-muted-foreground",
  struck: "border-border bg-muted text-muted-foreground line-through",
  absent: "border-dashed border-border bg-background text-muted-foreground italic",
} as const;

export type BoxTone = keyof typeof BOX_TONE;

export function Box({
  tone = "neutral",
  marker,
  title,
  children,
}: {
  readonly tone?: BoxTone;
  /** A shape, so the box still carries meaning without its colour. */
  readonly marker?: string;
  readonly title?: string;
  readonly children: ReactNode;
}) {
  return (
    <span className={cn(BOX_BASE, BOX_TONE[tone])} title={title}>
      {marker ? (
        <span className="font-mono text-micro" aria-hidden="true">
          {marker}
        </span>
      ) : null}
      {children}
    </span>
  );
}

/** The boxed form of an absent categorical value. Never used in a number column. */
export function AbsentBox({ label = "none" }: { readonly label?: string }) {
  return <Box tone="quiet">{label}</Box>;
}

/**
 * A value this system genuinely does not hold, as opposed to one that is unset.
 * Used for the fields Clerk owns: zpecs stores no name, email or password.
 */
export function NotStoredBox({
  label = "not stored",
  title,
}: {
  readonly label?: string;
  readonly title?: string;
}) {
  return (
    <Box tone="absent" title={title ?? "zpecs does not store this value"}>
      {label}
    </Box>
  );
}

/** Unboxed absence, for a prose or quantitative slot where no column alignment is at stake. */
export function Absent({ label = "none" }: { readonly label?: string }) {
  return <span className="text-muted-foreground text-xs">{label}</span>;
}

/* ---------------------------------------------------------------- status -- */

/**
 * One tone per stored status across all five vocabularies.
 *
 * `deprecated` is `quiet` and not `struck`: a deprecated Rule stays addressable
 * and every reference to it stays explainable, so striking it through would
 * claim it had been voided. `cancelled` is struck because it genuinely was.
 */
const STATUS_TONE: Record<EntityStatus, BoxTone> = {
  draft: "neutral",
  planned: "dashed",
  ready: "info",
  in_progress: "warning",
  blocked: "danger",
  in_review: "neutral",
  completed: "success",
  done: "success",
  cancelled: "struck",
  active: "success",
  paused: "neutral",
  archived: "quiet",
  deprecated: "quiet",
};

export function StatusCell({
  status,
  muted,
}: {
  readonly status: EntityStatus;
  /**
   * A dependency-blocked row quiets its stored status so the blocker is the only
   * loud thing in the row. The two signals never merge into one column, but on a
   * blocked row the blocker is the one that answers "why is this not moving".
   */
  readonly muted?: boolean;
}) {
  return (
    <Box tone={muted ? "quiet" : STATUS_TONE[status]} marker={statusMarker(status)}>
      {statusLabel(status)}
    </Box>
  );
}

/* -------------------------------------------------------------- priority -- */

/**
 * Business urgency, which borrows only `danger` from the semantic four —
 * critical and high differ by weight rather than by hue, so the other three
 * colours keep meaning states and nothing else.
 */
const PRIORITY_TONE: Record<EntityPriority, BoxTone> = {
  critical: "danger",
  high: "danger",
  medium: "neutral",
  low: "quiet",
};

const PRIORITY_WEIGHT: Record<EntityPriority, string> = {
  critical: "font-semibold",
  high: "font-medium",
  medium: "",
  low: "",
};

export function PriorityCell({ priority }: { readonly priority: EntityPriority | null }) {
  if (priority === null) return <AbsentBox label="none set" />;
  return (
    <span
      className={cn(
        BOX_BASE,
        BOX_TONE[PRIORITY_TONE[priority]],
        "font-mono text-micro tracking-tight",
        PRIORITY_WEIGHT[priority],
      )}
    >
      {priority}
    </span>
  );
}

/* ------------------------------------------------------------ dependency -- */

/**
 * Dependency blocking — a signal entirely separate from the stored status.
 *
 * `met` and `none` are two different answers: `met` means prerequisites exist
 * and every one of them is satisfied, `none` means there were never any. A
 * column that collapsed both into an empty cell would lose the distinction
 * between work that was unblocked and work that was never blocked.
 */
export type DependencyState =
  | { readonly kind: "blocked"; readonly openCount: number }
  | { readonly kind: "met" }
  | { readonly kind: "none" };

export function DependencyCell({ dependency }: { readonly dependency: DependencyState }) {
  if (dependency.kind === "blocked") {
    return (
      <Box tone="danger" marker="⊘">
        {dependency.openCount === 1 ? "Blocked" : `Blocked ×${String(dependency.openCount)}`}
      </Box>
    );
  }
  return <AbsentBox label={dependency.kind === "met" ? "met" : "none"} />;
}

/* -------------------------------------------------------------- executor -- */

/**
 * Who may pick a Task up — a stored preference, never a live execution.
 *
 * An absent executor reads "Unspecified" and never "either". `either` is a real
 * stored value meaning anyone may take it; absence means nobody has decided.
 * Rendering the second as the first would invent a decision.
 */
export function ExecutorCell({ executor }: { readonly executor: ExecutorKind | null }) {
  if (executor === null) return <AbsentBox label="Unspecified" />;
  return <Box tone="neutral">{executor.toUpperCase()}</Box>;
}

export { BOX_BASE, BOX_TONE };
