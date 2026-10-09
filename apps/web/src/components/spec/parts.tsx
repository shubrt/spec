import { useState, type MouseEvent, type ReactNode } from "react";
import { cn } from "~/lib/utils";

/**
 * The presentation atoms every screen is assembled from: hints, keys, headings,
 * definition rows and metric grids.
 *
 * Two rules run through all of them.
 *
 * A key is a link everywhere it appears. {@link EntityKey} does it for entities
 * and {@link RuleChip} for Rule applications — which used to be inert chips. The
 * statement behind `R-57` lives on another screen entirely, and a chip you
 * cannot open is a dead end wearing the clothes of a link.
 *
 * An aside waits to be asked for. {@link InfoHint} is a 15 px button that opens
 * on deliberate hover or focus; the explanation of why a column means what it
 * means is genuinely important and genuinely not what you are reading.
 */

/* -------------------------------------------------------------- InfoHint -- */

export function InfoHint({
  children,
  align = "left",
  width = 300,
  label = "More information",
}: {
  readonly children: ReactNode;
  readonly align?: "left" | "right";
  readonly width?: number;
  readonly label?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative inline-flex align-middle">
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={(event) => {
          event.stopPropagation();
          setOpen(!open);
        }}
        className="text-muted-foreground hover:text-foreground focus-visible:ring-ring border-border-strong flex size-[15px] shrink-0 items-center justify-center rounded-full border font-mono text-[9px] leading-none outline-none focus-visible:ring-2 focus-visible:ring-offset-1"
      >
        i
      </button>
      {open ? (
        <span
          role="tooltip"
          style={{ width }}
          className={cn(
            "bg-popover text-popover-foreground border-border-strong absolute top-5 z-[60] rounded-md border p-2.5 text-xs font-normal normal-case leading-[17px] tracking-normal shadow-[0_2px_10px_rgba(0,0,0,0.10)]",
            align === "right" ? "right-0" : "left-0",
          )}
        >
          {children}
        </span>
      ) : null}
    </span>
  );
}

/* -------------------------------------------------------------- key link -- */

export function EntityKey({
  entityKey,
  onClick,
  className,
}: {
  readonly entityKey: string;
  readonly onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  readonly className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "focus-visible:ring-ring shrink-0 rounded-sm font-mono text-xs font-medium underline decoration-transparent underline-offset-2 outline-none transition-colors hover:decoration-current focus-visible:ring-2",
        className,
      )}
    >
      {entityKey}
    </button>
  );
}

/** A Rule application. Same shape as a {@link Chip}, but it opens the Rule. */
export function RuleChip({
  ruleKey,
  title,
  onClick,
}: {
  readonly ruleKey: string;
  readonly title?: string;
  readonly onClick: (ruleKey: string) => void;
}) {
  return (
    <button
      type="button"
      title={title ?? ruleKey}
      aria-label={`Open Rule ${ruleKey}`}
      onClick={(event) => {
        event.stopPropagation();
        onClick(ruleKey);
      }}
      className="border-input text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-ring inline-flex shrink-0 items-center rounded-sm border px-1.5 py-0.5 font-mono text-[11px] outline-none transition-colors focus-visible:ring-2"
    >
      {ruleKey}
    </button>
  );
}

/** An inert label: a scope name, a source id, a fragment reference. */
export function Chip({
  children,
  variant = "solid",
  title,
}: {
  readonly children: ReactNode;
  readonly variant?: "solid" | "dotted";
  readonly title?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center rounded-sm px-1.5 py-0.5 font-mono text-[11px]",
        variant === "dotted"
          ? "border-border-strong text-muted-foreground border border-dotted"
          : "border-input text-muted-foreground border",
      )}
    >
      {children}
    </span>
  );
}

export function ExternalLinkIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="12"
      height="12"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
    >
      <path d="M9 3.5h3.5V7" />
      <path d="M12.5 3.5 7.5 8.5" />
      <path d="M12 9.5v3h-9v-9h3" />
    </svg>
  );
}

/* ------------------------------------------------------------------ Tabs -- */

export interface TabDefinition {
  readonly id: string;
  readonly label: string;
  /** Optional. An empty one used to render an empty pill, which read as a stray dash. */
  readonly count?: number | string;
}

export function Tabs({
  tabs,
  value,
  onChange,
}: {
  readonly tabs: readonly TabDefinition[];
  readonly value: string;
  readonly onChange: (id: string) => void;
}) {
  return (
    <div role="tablist" className="border-border-strong flex items-end gap-5 border-b">
      {tabs.map((tab) => {
        const active = tab.id === value;
        const hasCount = tab.count !== undefined && tab.count !== "";
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(tab.id)}
            className={cn(
              "focus-visible:ring-ring -mb-px flex items-center gap-2 border-b-2 pb-2 pt-1 text-[13px] outline-none transition-colors focus-visible:ring-2",
              active
                ? "border-primary text-foreground font-medium"
                : "text-muted-foreground hover:text-foreground border-transparent",
            )}
          >
            <span>{tab.label}</span>
            {hasCount ? (
              <span
                className={cn(
                  "rounded-sm px-1.5 py-0.5 font-mono text-[11px] tabular-nums",
                  active ? "bg-muted text-foreground" : "text-muted-foreground",
                )}
              >
                {tab.count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

/* -------------------------------------------------------------- headings -- */

/**
 * Three heading levels exist and no more: the page, a major section, a part.
 * A screen that repeats its own name at 26 px three times over has no hierarchy,
 * only emphasis.
 */
export function PageHead({
  title,
  count,
  hint,
  children,
}: {
  readonly title: string;
  readonly count?: number | string;
  readonly hint?: ReactNode;
  readonly children?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-2.5 pb-4">
      <h1 className="text-[26px] font-medium leading-8 tracking-tight">{title}</h1>
      {count !== undefined ? (
        <span className="text-muted-foreground font-mono text-sm tabular-nums">{count}</span>
      ) : null}
      {hint ? <InfoHint width={340}>{hint}</InfoHint> : null}
      <div className="ml-auto flex items-center gap-2">{children}</div>
    </div>
  );
}

/** A major section — a Milestone on the Roadmap. Subordinate to the page at 19 px. */
export function SectionHead({
  title,
  count,
  hint,
  children,
}: {
  readonly title: string;
  readonly count?: number | string;
  readonly hint?: ReactNode;
  readonly children?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 pb-2">
      <h2 className="text-[19px] font-medium leading-6 tracking-tight">{title}</h2>
      {count !== undefined ? (
        <span className="text-muted-foreground font-mono text-xs tabular-nums">{count}</span>
      ) : null}
      {hint ? <InfoHint width={340}>{hint}</InfoHint> : null}
      <div className="ml-auto flex items-center gap-2">{children}</div>
    </div>
  );
}

/**
 * The line under a tab strip. It says what the number actually counts — which is
 * something neither the tab nor the breadcrumb above it says.
 */
export function SubHead({
  caption,
  count,
  hint,
}: {
  readonly caption: string;
  readonly count?: number | string;
  readonly hint?: ReactNode;
}) {
  return (
    <div className="flex items-baseline gap-2 pb-3 pt-4">
      <h2 className="text-[15px] font-medium leading-5">{caption}</h2>
      {count !== undefined ? (
        <span className="text-muted-foreground font-mono text-xs tabular-nums">{count}</span>
      ) : null}
      {hint ? <InfoHint width={340}>{hint}</InfoHint> : null}
    </div>
  );
}

/** The 11 px mono label that opens a document section. */
export function DocSection({
  label,
  count,
  hint,
  note,
  children,
}: {
  readonly label: string;
  readonly count?: number | string;
  readonly hint?: ReactNode;
  readonly note?: ReactNode;
  readonly children?: ReactNode;
}) {
  return (
    <section className="pt-5 first:pt-0">
      <div className="border-border-strong mb-1 flex items-center gap-1.5 border-b pb-1">
        <h2 className="text-micro font-mono font-semibold uppercase tracking-wider">{label}</h2>
        {count !== undefined ? (
          <span className="text-muted-foreground font-mono text-micro tabular-nums">{count}</span>
        ) : null}
        {hint ? <InfoHint width={330}>{hint}</InfoHint> : null}
      </div>
      {note ? <p className="text-muted-foreground py-2 text-xs leading-[17px]">{note}</p> : null}
      {children}
    </section>
  );
}

/** The same label one level down, inside a section that already has a heading. */
export function PartHead({
  title,
  count,
  hint,
  children,
}: {
  readonly title: string;
  readonly count?: number | string;
  readonly hint?: ReactNode;
  readonly children?: ReactNode;
}) {
  return (
    <div className="border-border-strong mb-1 flex items-center gap-1.5 border-b pb-1">
      <h3 className="text-micro font-mono font-semibold uppercase tracking-wider">{title}</h3>
      {count !== undefined ? (
        <span className="text-muted-foreground font-mono text-micro tabular-nums">{count}</span>
      ) : null}
      {hint ? <InfoHint width={330}>{hint}</InfoHint> : null}
      <div className="ml-auto flex items-center gap-2">{children}</div>
    </div>
  );
}

/** A block in the narrow context column. Nothing in it is prose of any length. */
export function ContextBlock({
  label,
  hint,
  children,
}: {
  readonly label: string;
  readonly hint?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <div className="border-border border-b py-3 first:pt-0">
      <div className="mb-1.5 flex items-center gap-1.5">
        <span className="text-muted-foreground text-micro font-mono font-semibold uppercase tracking-wider">
          {label}
        </span>
        {hint ? (
          <InfoHint width={300} align="right">
            {hint}
          </InfoHint>
        ) : null}
      </div>
      {children}
    </div>
  );
}

/** A section inside the 440 px drawer. */
export function DrawerSection({
  label,
  count,
  hint,
  children,
}: {
  readonly label: string;
  readonly count?: number | string;
  readonly hint?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <section className="border-border border-b py-3.5 last:border-0">
      <div className="mb-2 flex items-center gap-1.5">
        <h3 className="text-micro font-mono font-semibold uppercase tracking-wider">{label}</h3>
        {count !== undefined ? (
          <span className="text-muted-foreground font-mono text-micro tabular-nums">{count}</span>
        ) : null}
        {hint ? <InfoHint width={300}>{hint}</InfoHint> : null}
      </div>
      {children}
    </section>
  );
}

/* ----------------------------------------------------------------- rows -- */

export function DefRow({
  label,
  hint,
  children,
}: {
  readonly label: string;
  readonly hint?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex items-baseline gap-3 py-1">
      <span className="text-muted-foreground flex w-[104px] shrink-0 items-center gap-1 text-xs">
        {label}
        {hint ? <InfoHint width={280}>{hint}</InfoHint> : null}
      </span>
      <span className="text-ledger min-w-0 flex-1">{children}</span>
    </div>
  );
}

export interface Metric {
  readonly label: string;
  readonly value: number | string;
}

export function MetricGrid({ items }: { readonly items: readonly Metric[] }) {
  return (
    <div className="border-border grid grid-cols-2 gap-x-3 border-t">
      {items.map((metric, index) => (
        <div
          key={metric.label}
          className={cn(
            "border-border flex items-baseline gap-2 border-b py-2",
            index % 2 === 0 ? "pr-3" : "pl-3",
          )}
        >
          <span className="font-mono text-sm tabular-nums">{metric.value}</span>
          <span className="text-muted-foreground text-xs leading-4">{metric.label}</span>
        </div>
      ))}
    </div>
  );
}

export interface TableNoteItem {
  readonly label: string;
  readonly value: number | string;
  readonly tone?: "danger";
  readonly hint?: ReactNode;
}

/** The strip of counted facts above a table. */
export function TableNote({ items }: { readonly items: readonly TableNoteItem[] }) {
  return (
    <div className="border-border flex flex-wrap items-center gap-x-5 gap-y-1 border-b py-2">
      {items.map((item) => (
        <span key={item.label} className="inline-flex items-baseline gap-1.5">
          <span
            className={cn(
              "font-mono text-xs tabular-nums",
              item.tone === "danger" ? "text-danger font-semibold" : "",
            )}
          >
            {item.value}
          </span>
          <span className="text-muted-foreground text-xs">{item.label}</span>
          {item.hint ? <InfoHint width={320}>{item.hint}</InfoHint> : null}
        </span>
      ))}
    </div>
  );
}

export function EmptyState({ label, hint }: { readonly label: string; readonly hint?: ReactNode }) {
  return (
    <div className="border-border flex items-center gap-2 border-b py-6">
      <span className="text-muted-foreground text-ledger">{label}</span>
      {hint ? <InfoHint width={360}>{hint}</InfoHint> : null}
    </div>
  );
}

/* -------------------------------------------------------------- clipboard -- */

/** Copies a string and says so for a moment. */
export function CopyButton({
  text,
  label = "Copy link",
}: {
  readonly text: string;
  readonly label?: string;
}) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      title={`Copy ${text}`}
      onClick={() => {
        void navigator.clipboard?.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      }}
      className="border-input hover:bg-accent focus-visible:ring-ring focus-visible:ring-offset-background inline-flex h-8 shrink-0 items-center rounded-md border px-3 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-offset-2"
    >
      {done ? "Copied" : label}
    </button>
  );
}

/** A shell command, with the copy control that is the whole point of showing it. */
export function CommandLine({ command }: { readonly command: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="border-border bg-muted/50 mt-1.5 flex items-center gap-2 rounded-md border px-2.5 py-2">
      <code className="min-w-0 flex-1 truncate font-mono text-[11px]">{command}</code>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard?.writeText(command);
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        }}
        className="hover:bg-accent focus-visible:ring-ring shrink-0 rounded-md px-2 py-1 text-xs font-medium outline-none focus-visible:ring-2"
      >
        {done ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

/**
 * Capabilities left out on purpose, named rather than hidden.
 *
 * A comparable product has each of these. Listing them says "this was a
 * decision", which is a different statement from a screen that simply lacks
 * them.
 */
export function NotOffered({ items }: { readonly items: readonly string[] }) {
  return (
    <>
      {items.map((item) => (
        <div key={item} className="flex items-center gap-2 py-1">
          <span className="text-muted-foreground font-mono text-xs">—</span>
          <span className="text-muted-foreground text-xs">{item}</span>
        </div>
      ))}
    </>
  );
}
