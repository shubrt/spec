import type { ReactNode } from "react";
import { Badge } from "~/components/ui/badge";
import { cn } from "~/lib/utils";
import type { Tone } from "~/lib/vocabulary";

/**
 * The presentational primitives that render zpecs' status vocabularies through
 * the ported `data-tone` system.
 *
 * The equivalent file in `apps/legacy project` is `components/pm/tokens.tsx`, which could
 * not be ported: it resolves labels through legacy project's own status vocabulary, which
 * is not zpecs'. The CSS underneath — `.tone-dot`, `.tone-pill`, `.rule-tag` in
 * `styles.css` — is byte-identical, so the two dashboards stay one visual system.
 *
 * Tone is passed in rather than derived here, because which vocabulary a status
 * belongs to is what makes the mapping exhaustive, and only the caller knows
 * whether it is holding an epic, a stream or a task.
 */

export function StatusBadge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <Badge variant="tone" data-tone={tone}>
      {children}
    </Badge>
  );
}

export function StatusDot({ tone, className }: { tone: Tone; className?: string }) {
  return <span className={cn("tone-dot", className)} data-tone={tone} />;
}

/** The stream or task type. A plain label: the type says what kind of work it is, not how it is going. */
export function TypeTag({ children }: { children: ReactNode }) {
  return (
    <span className="text-[11px] font-medium uppercase tracking-[0.04em] text-muted-foreground">
      {children}
    </span>
  );
}

/**
 * A generated entity key — `EPIC-1`, `STR-3`, `TASK-12`.
 *
 * Monospaced and coloured because it is the handle a person uses to refer to the
 * entity in conversation with the agent, so it needs to be scannable.
 */
export function EntityKey({ children }: { children: ReactNode }) {
  return (
    <span className="flex-none font-mono text-[11px] font-semibold text-primary">{children}</span>
  );
}

/** A document section id — `FR-001`, `AC-002`, `BR-001`. */
export function SectionId({ children }: { children: ReactNode }) {
  return <span className="rule-tag">{children}</span>;
}
