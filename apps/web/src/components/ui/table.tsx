import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "~/lib/utils";

/**
 * shadcn's table, plus the one thing stock does not have: a density.
 *
 * Every deviation is marked LEDGER. Density and header weight are added as cva
 * variants rather than as className overrides from the call site, which is how a
 * shadcn consumer is meant to extend a component — a caller passing conflicting
 * padding utilities would win against the component and drift row by row.
 *
 * `table-fixed` with an explicit `<colgroup>` is load-bearing at eleven columns:
 * auto layout lets one long title push a Status box out of alignment with the
 * box in the row above it, and a categorical column that does not line up stops
 * being scannable.
 */

function Table({ className, children, ...props }: React.ComponentProps<"table">) {
  return (
    <div data-slot="table-container" className="relative w-full">
      <table
        data-slot="table"
        className={cn("w-full table-fixed caption-bottom text-sm", className)}
        {...props}
      >
        {children}
      </table>
    </div>
  );
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return <thead data-slot="table-header" className={cn("[&_tr]:border-b", className)} {...props} />;
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return (
    <tbody
      data-slot="table-body"
      className={cn("[&_tr:last-child]:border-0", className)}
      {...props}
    />
  );
}

const tableRowVariants = cva("border-b transition-colors", {
  variants: {
    // LEDGER: stock TableRow has no density variant. 40 px compact and 48 px
    // comfortable are the two row heights this app uses.
    size: { default: "", compact: "h-10", comfortable: "h-12" },
  },
  defaultVariants: { size: "default" },
});

function TableRow({
  className,
  size,
  ...props
}: React.ComponentProps<"tr"> & VariantProps<typeof tableRowVariants>) {
  return <tr data-slot="table-row" className={tableRowVariants({ size, className })} {...props} />;
}

const tableHeadVariants = cva("text-left align-middle overflow-hidden text-ellipsis", {
  variants: {
    size: {
      default: "text-foreground h-10 px-2 font-medium",
      // LEDGER: 11/16 at 600, uppercase — the ledger header.
      ledger:
        "h-9 px-1.5 text-micro font-semibold uppercase tracking-wide text-muted-foreground whitespace-nowrap",
    },
  },
  defaultVariants: { size: "default" },
});

function TableHead({
  className,
  size,
  ...props
}: React.ComponentProps<"th"> & VariantProps<typeof tableHeadVariants>) {
  return (
    <th data-slot="table-head" className={tableHeadVariants({ size, className })} {...props} />
  );
}

const tableCellVariants = cva("align-middle", {
  variants: {
    size: {
      default: "p-2 whitespace-nowrap",
      // LEDGER: 13/18 dense row text, tighter gutters so the title column survives.
      ledger: "px-1.5 py-0 text-ledger whitespace-nowrap overflow-hidden text-ellipsis",
    },
  },
  defaultVariants: { size: "default" },
});

function TableCell({
  className,
  size,
  ...props
}: React.ComponentProps<"td"> & VariantProps<typeof tableCellVariants>) {
  return (
    <td data-slot="table-cell" className={tableCellVariants({ size, className })} {...props} />
  );
}

export { Table, TableHeader, TableBody, TableRow, TableHead, TableCell };
