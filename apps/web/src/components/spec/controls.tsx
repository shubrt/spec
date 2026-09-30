import { useEffect, useRef, useState } from "react";
import { cn } from "~/lib/utils";

/**
 * The form controls more than one screen uses.
 *
 * Every one of them shows an active state, because a filter you cannot see is a
 * filter you will forget you set — and then read a partial answer as the whole one.
 */

/** A single-select you can type in. A native select cannot search, and fifty options is past scrolling. */
export function SearchSelect({
  label,
  value,
  options,
  onChange,
  width = 150,
  placeholder = "Any",
  align = "left",
}: {
  readonly label: string;
  readonly value: string | undefined;
  readonly options: readonly { readonly key: string; readonly label: string }[];
  readonly onChange: (value: string | undefined) => void;
  readonly width?: number;
  readonly placeholder?: string;
  /** `right` for a control near the frame edge: the list is 280 px against a 110 px trigger. */
  readonly align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const container = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const away = (event: MouseEvent) => {
      if (container.current && !container.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  const needle = query.trim().toLowerCase();
  const shown = needle
    ? options.filter((option) => `${option.key} ${option.label}`.toLowerCase().includes(needle))
    : options;
  const current = options.find((option) => option.key === value);

  return (
    <span ref={container} className="relative inline-flex items-center gap-1.5">
      <span className="text-muted-foreground text-[11px]">{label}</span>
      <button
        type="button"
        onClick={() => {
          setOpen(!open);
          setQuery("");
        }}
        aria-haspopup="listbox"
        aria-expanded={open}
        style={{ width }}
        className={cn(
          "border-input hover:bg-muted focus-visible:ring-ring flex h-7 items-center gap-1.5 rounded-md border px-2 text-xs outline-none focus-visible:ring-2",
          value ? "bg-accent border-border-strong" : "",
        )}
      >
        <span className="min-w-0 flex-1 truncate text-left">{current?.key ?? placeholder}</span>
        <span className="font-mono text-[9px] opacity-60">▾</span>
      </button>
      {open ? (
        <div
          className={cn(
            "border-border-strong bg-popover absolute top-[calc(100%+4px)] z-[70] w-[280px] rounded-md border p-1 shadow-[0_6px_24px_rgba(0,0,0,0.12)]",
            align === "right" ? "right-0" : "left-0",
          )}
        >
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search…"
            aria-label={`Search ${label}`}
            className="border-input focus-visible:ring-ring bg-background mb-1 h-7 w-full rounded-sm border px-2 text-xs outline-none focus-visible:ring-2"
          />
          <div className="max-h-[240px] overflow-auto" role="listbox">
            <button
              type="button"
              onClick={() => {
                onChange(undefined);
                setOpen(false);
              }}
              className="hover:bg-muted flex w-full items-center rounded-sm px-2 py-1.5 text-left text-xs"
            >
              {placeholder}
            </button>
            {shown.map((option) => (
              <button
                key={option.key}
                type="button"
                role="option"
                aria-selected={option.key === value}
                onClick={() => {
                  onChange(option.key);
                  setOpen(false);
                }}
                className={cn(
                  "hover:bg-muted flex w-full items-baseline gap-2 rounded-sm px-2 py-1.5 text-left text-xs",
                  option.key === value ? "bg-accent" : "",
                )}
              >
                <span className="w-12 shrink-0 font-mono text-[11px]">{option.key}</span>
                <span className="text-muted-foreground min-w-0 flex-1 truncate">
                  {option.label}
                </span>
              </button>
            ))}
            {shown.length === 0 ? (
              <div className="text-muted-foreground px-2 py-2 text-xs">Nothing matches</div>
            ) : null}
          </div>
        </div>
      ) : null}
    </span>
  );
}

export function PlainSelect({
  label,
  value,
  options,
  onChange,
  width = 120,
  anyLabel = "Any",
}: {
  readonly label: string;
  readonly value: string | undefined;
  readonly options: readonly (readonly [string, string])[];
  readonly onChange: (value: string | undefined) => void;
  readonly width?: number;
  readonly anyLabel?: string;
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="text-muted-foreground text-[11px]">{label}</span>
      <select
        value={value ?? ""}
        aria-label={label}
        onChange={(event) => onChange(event.target.value || undefined)}
        style={{ width }}
        className={cn(
          "border-input focus-visible:ring-ring text-foreground bg-background h-7 rounded-md border px-1.5 text-xs outline-none focus-visible:ring-2",
          value ? "bg-accent border-border-strong" : "",
        )}
      >
        <option value="">{anyLabel}</option>
        {options.map(([optionValue, optionLabel]) => (
          <option key={optionValue} value={optionValue}>
            {optionLabel}
          </option>
        ))}
      </select>
    </span>
  );
}

/**
 * A date bound on the revision log.
 *
 * The only date input in the app, and it filters *recorded* timestamps. There is
 * nothing here to schedule: no field anywhere accepts a due date, a deadline or a
 * sprint boundary, because none is stored.
 */
export function DateField({
  label,
  value,
  onChange,
  min,
  max,
}: {
  readonly label: string;
  readonly value: string | undefined;
  readonly onChange: (value: string | undefined) => void;
  readonly min?: string;
  readonly max?: string;
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="text-muted-foreground text-[11px]">{label}</span>
      <input
        type="date"
        aria-label={label}
        value={value ?? ""}
        min={min}
        max={max}
        onChange={(event) => onChange(event.target.value || undefined)}
        className={cn(
          "border-input focus-visible:ring-ring text-foreground bg-background h-7 w-[132px] rounded-md border px-1.5 font-mono text-xs outline-none focus-visible:ring-2",
          value ? "bg-accent border-border-strong" : "",
        )}
      />
    </span>
  );
}

export function SearchField({
  value,
  onChange,
  placeholder,
  width = 220,
  label = "Search",
}: {
  readonly value: string | undefined;
  readonly onChange: (value: string | undefined) => void;
  readonly placeholder: string;
  readonly width?: number;
  readonly label?: string;
}) {
  return (
    <input
      value={value ?? ""}
      aria-label={label}
      onChange={(event) => onChange(event.target.value || undefined)}
      placeholder={placeholder}
      style={{ width }}
      className={cn(
        "border-input focus-visible:ring-ring bg-background h-7 rounded-md border px-2 text-xs outline-none focus-visible:ring-2",
        value ? "bg-accent border-border-strong" : "",
      )}
    />
  );
}

/** A one-question toggle: what can start, what is stuck, what is unresolved. */
export function FilterToggle({
  label,
  active,
  count,
  onToggle,
  title,
}: {
  readonly label: string;
  readonly active: boolean;
  readonly count?: number;
  readonly onToggle: () => void;
  readonly title?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onToggle}
      title={title}
      className={cn(
        "focus-visible:ring-ring inline-flex h-7 shrink-0 items-center gap-2 rounded-md border px-2.5 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-offset-2",
        active
          ? "border-primary bg-primary text-primary-foreground"
          : "border-input hover:bg-muted",
      )}
    >
      <span>{label}</span>
      {count === undefined ? null : (
        <span className="font-mono text-[11px] tabular-nums opacity-70">{count}</span>
      )}
    </button>
  );
}

/** A chip that filters a list to one value. Clicking the active one clears it. */
export function ChipFilter({
  label,
  count,
  active,
  onClick,
}: {
  readonly label: string;
  readonly count: number;
  readonly active: boolean;
  readonly onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "border-input hover:bg-muted focus-visible:ring-ring inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-xs outline-none focus-visible:ring-2",
        active ? "bg-accent border-border-strong" : "",
      )}
    >
      {label}
      <span className="font-mono text-[11px] tabular-nums opacity-70">{count}</span>
    </button>
  );
}

/** The row every filter bar sits in. */
export function FilterBar({ children }: { readonly children: React.ReactNode }) {
  return (
    <div className="border-border flex flex-wrap items-center gap-x-4 gap-y-2 border-b py-2.5">
      {children}
    </div>
  );
}

/**
 * The "clear n filters" control.
 *
 * Only rendered when something is set, and it says how many — a reader who has
 * narrowed a list three times needs to know that before trusting the count.
 */
export function ClearFilters({
  count,
  onClear,
}: {
  readonly count: number;
  readonly onClear: () => void;
}) {
  if (count === 0) return null;
  return (
    <button
      type="button"
      onClick={onClear}
      className="border-input hover:bg-accent focus-visible:ring-ring inline-flex h-8 items-center rounded-md border px-3 text-xs font-medium outline-none focus-visible:ring-2"
    >
      {`Clear ${String(count)} filter${count === 1 ? "" : "s"}`}
    </button>
  );
}
