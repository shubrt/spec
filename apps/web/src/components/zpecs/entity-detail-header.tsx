import type { ReactNode } from "react";
import { SheetDescription, SheetHeader, SheetTitle } from "~/components/ui/sheet";
import type { EntityDetailSurface } from "~/components/zpecs/entity-detail-surface";

export {
  EntityDetailSurfaceProvider,
  type EntityDetailSurface,
} from "~/components/zpecs/entity-detail-surface";

interface EntityDetailHeaderProps {
  surface: EntityDetailSurface;
  eyebrow: ReactNode;
  title: string;
  metadata: ReactNode;
}

/**
 * The shared identity block above every entity document.
 *
 * A drawer needs Radix's title and description primitives for its accessible
 * dialog labelling. The standalone page renders the same information with
 * ordinary document semantics, so it does not pretend to be part of a dialog.
 */
export function EntityDetailHeader({ surface, eyebrow, title, metadata }: EntityDetailHeaderProps) {
  const eyebrowLine = (
    <div className="flex flex-wrap items-center gap-2.5 text-xs text-muted-foreground">
      {eyebrow}
    </div>
  );
  const metadataLine = <div className="flex flex-wrap items-center gap-2">{metadata}</div>;

  if (surface === "drawer") {
    return (
      <SheetHeader className="border-b pr-24">
        {eyebrowLine}
        <SheetTitle>{title}</SheetTitle>
        <SheetDescription asChild>{metadataLine}</SheetDescription>
      </SheetHeader>
    );
  }

  return (
    <header className="flex flex-col gap-2 border-b p-6 pb-4">
      {eyebrowLine}
      <h1 className="text-lg font-bold tracking-tight text-foreground">{title}</h1>
      {metadataLine}
    </header>
  );
}
