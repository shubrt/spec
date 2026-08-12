import { Fragment, useEffect, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { cn } from "~/lib/utils";
import { EmptyState } from "./parts";

/**
 * EntityTable — the single table used by every view.
 *
 * Column explanations are native `title` tooltips on the header itself, not a row
 * of little `i` buttons. At eleven columns those buttons were louder than the
 * data they annotated; a slow hover over the header reaches the same text without
 * putting a control in every heading.
 *
 * A table without `onSelect` renders rows that are genuinely inert: no pointer
 * cursor, no tab stop, no `aria-selected`, no hover. Seven tables in the earlier
 * design passed an empty handler, so their rows promised an interaction and then
 * answered nothing.
 *
 * Numbers are numbers. A count of zero reads `0`, never "none" — "none" belongs
 * to a field that holds nothing at all.
 */

const PAGE_SIZES = [10, 20, 50, 100] as const;

/** Every row must carry a stable identity; the key column is not assumed. */
export interface TableRowShape {
  readonly key: string;
}

export interface Column<Row extends TableRowShape> {
  readonly id: string;
  readonly label: string;
  /** Fixed width in px. Omit and set `flex` for the one column that absorbs slack. */
  readonly width?: number;
  readonly flex?: boolean;
  readonly align?: "right";
  readonly cellClass?: string;
  /**
   * Present makes the header a sort control. Returning a number sorts
   * numerically; anything else is compared as a locale string.
   */
  readonly sort?: (row: Row) => number | string;
  readonly render?: (row: Row) => ReactNode;
  /** Why this column means what it means. Becomes the header's native tooltip. */
  readonly hint?: string;
}

type SortState = { readonly id: string; readonly direction: "asc" | "desc" };

function sortIndicator(direction: SortState["direction"]): string {
  return direction === "asc" ? "↑" : "↓";
}

function Pagination({
  total,
  page,
  pageSize,
  onPage,
  onPageSize,
}: {
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly onPage: (page: number) => void;
  readonly onPageSize: (size: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : page * pageSize + 1;
  const to = Math.min(total, (page + 1) * pageSize);

  return (
    <div className="border-border flex items-center gap-3 border-t py-2.5">
      <label className="text-muted-foreground flex items-center gap-2 text-xs">
        Rows per page
        <select
          value={pageSize}
          onChange={(event) => onPageSize(Number(event.target.value))}
          className="border-input focus-visible:ring-ring text-foreground bg-background h-7 rounded-md border px-1.5 font-mono text-xs outline-none focus-visible:ring-2"
        >
          {PAGE_SIZES.map((size) => (
            <option key={size} value={size}>
              {size}
            </option>
          ))}
        </select>
      </label>

      <span className="text-muted-foreground ml-auto font-mono text-xs tabular-nums">
        {`${String(from)}–${String(to)} of ${String(total)}`}
      </span>

      <div className="flex items-center gap-1">
        <button
          type="button"
          disabled={page === 0}
          onClick={() => onPage(page - 1)}
          aria-label="Previous page"
          className="border-input hover:bg-accent focus-visible:ring-ring inline-flex h-6 items-center rounded-md border px-2 text-xs outline-none focus-visible:ring-2 disabled:pointer-events-none disabled:opacity-50"
        >
          Previous
        </button>
        <span className="text-muted-foreground px-2 font-mono text-xs tabular-nums">
          {`${String(page + 1)} / ${String(pages)}`}
        </span>
        <button
          type="button"
          disabled={page >= pages - 1}
          onClick={() => onPage(page + 1)}
          aria-label="Next page"
          className="border-input hover:bg-accent focus-visible:ring-ring inline-flex h-6 items-center rounded-md border px-2 text-xs outline-none focus-visible:ring-2 disabled:pointer-events-none disabled:opacity-50"
        >
          Next
        </button>
      </div>
    </div>
  );
}

export function EntityTable<Row extends TableRowShape>({
  label,
  columns,
  rows,
  selectedKey,
  onSelect,
  expandedKeys,
  renderExpanded,
  defaultOrderLabel,
  emptyLabel = "No items",
  emptyHint,
  initialPageSize = 20,
}: {
  /** Names the table for a screen reader. Every table on a screen needs its own. */
  readonly label: string;
  readonly columns: readonly Column<Row>[];
  readonly rows: readonly Row[];
  readonly selectedKey?: string | null;
  /** Omitting this is how you say "this table is for reading". */
  readonly onSelect?: (key: string) => void;
  readonly expandedKeys?: Readonly<Record<string, boolean>>;
  readonly renderExpanded?: (row: Row) => ReactNode;
  /** States the order rows arrive in, while no column sort is applied. */
  readonly defaultOrderLabel?: string;
  readonly emptyLabel?: string;
  readonly emptyHint?: ReactNode;
  readonly initialPageSize?: number;
}) {
  const [sort, setSort] = useState<SortState | null>(null);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(initialPageSize);

  const interactive = typeof onSelect === "function";

  // A filter that shrinks the result below the current page would otherwise leave
  // the reader on an empty page they did not navigate to.
  useEffect(() => {
    setPage(0);
  }, [rows.length, pageSize]);

  const cycle = (column: Column<Row>) => {
    if (!column.sort) return;
    if (!sort || sort.id !== column.id) setSort({ id: column.id, direction: "asc" });
    else if (sort.direction === "asc") setSort({ id: column.id, direction: "desc" });
    else setSort(null);
    setPage(0);
  };

  let ordered: readonly Row[] = rows;
  if (sort) {
    const column = columns.find((candidate) => candidate.id === sort.id);
    const read = column?.sort;
    if (read) {
      ordered = [...rows].sort((left, right) => {
        const a = read(left);
        const b = read(right);
        const result =
          typeof a === "number" && typeof b === "number"
            ? a - b
            : String(a).localeCompare(String(b), "de");
        return sort.direction === "asc" ? result : -result;
      });
    }
  }

  const visible = ordered.slice(page * pageSize, (page + 1) * pageSize);

  const onRowKeyDown = (event: KeyboardEvent<HTMLTableRowElement>, key: string, index: number) => {
    if (!onSelect) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelect(key);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next = event.key === "ArrowDown" ? index + 1 : index - 1;
      const body = event.currentTarget.closest('[data-slot="table-body"]');
      const target = body?.querySelectorAll<HTMLElement>('[data-slot="table-row"][tabindex="0"]')[
        next
      ];
      target?.focus();
    }
  };

  return (
    <div>
      <Table aria-label={label}>
        <colgroup>
          {columns.map((column) => (
            <col key={column.id} style={column.flex ? undefined : { width: column.width }} />
          ))}
        </colgroup>
        <TableHeader className="[&_tr]:border-b-foreground bg-background sticky top-0 z-20">
          <TableRow>
            {columns.map((column) => {
              const active = sort?.id === column.id;
              // The explanation lives on the header itself. A native title waits
              // for a deliberate hover, which is what an aside should do.
              const tip = column.hint ?? (column.sort ? `Sort by ${column.label}` : undefined);
              return (
                <TableHead
                  key={column.id}
                  size="ledger"
                  className={column.align === "right" ? "text-right" : ""}
                >
                  <span
                    title={tip}
                    className={cn(
                      "inline-flex items-center gap-1",
                      column.align === "right" ? "justify-end" : "",
                    )}
                  >
                    {column.sort ? (
                      <button
                        type="button"
                        onClick={() => cycle(column)}
                        aria-label={`Sort by ${column.label}`}
                        className={cn(
                          "focus-visible:ring-ring hover:text-foreground rounded-sm uppercase outline-none focus-visible:ring-2 focus-visible:ring-offset-1",
                          active ? "text-foreground" : "",
                        )}
                      >
                        {column.label}
                        <span className="ml-1 font-mono text-[9px]">
                          {active && sort ? sortIndicator(sort.direction) : "⇅"}
                        </span>
                      </button>
                    ) : (
                      <span>{column.label}</span>
                    )}
                  </span>
                </TableHead>
              );
            })}
          </TableRow>
        </TableHeader>

        <TableBody>
          {visible.map((row, index) => {
            const selected = interactive && selectedKey === row.key;
            const expanded = expandedKeys?.[row.key] ?? false;
            return (
              <Fragment key={row.key}>
                <TableRow
                  size="comfortable"
                  tabIndex={interactive ? 0 : undefined}
                  aria-selected={interactive ? selected : undefined}
                  onKeyDown={
                    interactive ? (event) => onRowKeyDown(event, row.key, index) : undefined
                  }
                  onClick={interactive ? () => onSelect?.(row.key) : undefined}
                  className={cn(
                    "focus-visible:ring-ring outline-none focus-visible:ring-2 focus-visible:ring-inset",
                    interactive ? "cursor-pointer" : "",
                    selected
                      ? "bg-accent shadow-[inset_2px_0_0_0_var(--primary)]"
                      : interactive
                        ? "hover:bg-muted"
                        : "",
                  )}
                >
                  {columns.map((column) => (
                    <TableCell
                      key={column.id}
                      size="ledger"
                      className={cn(column.cellClass, column.align === "right" ? "text-right" : "")}
                    >
                      {column.render ? column.render(row) : null}
                    </TableCell>
                  ))}
                </TableRow>
                {expanded && renderExpanded ? (
                  <tr className="border-border border-b">
                    <td colSpan={columns.length} className="bg-muted/50 px-1.5 pb-3 pt-1">
                      {renderExpanded(row)}
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
        </TableBody>
      </Table>

      {ordered.length === 0 ? <EmptyState label={emptyLabel} hint={emptyHint} /> : null}

      {ordered.length > 0 ? (
        <Pagination
          total={ordered.length}
          page={page}
          pageSize={pageSize}
          onPage={setPage}
          onPageSize={setPageSize}
        />
      ) : null}

      {defaultOrderLabel && !sort ? (
        <div className="text-muted-foreground pt-1.5 text-[11px]">{defaultOrderLabel}</div>
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------- shared cell renderers */

/** A numeric column always shows a number. "none" would claim the field is empty. */
export function countCell(value: number) {
  return <span className="font-mono text-xs tabular-nums">{value}</span>;
}

export function fractionCell(done: number, total: number) {
  return (
    <span className="font-mono text-xs tabular-nums">{`${String(done)}/${String(total)}`}</span>
  );
}
