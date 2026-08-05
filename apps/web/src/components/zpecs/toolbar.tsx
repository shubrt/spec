import type { ReactNode } from "react";

/**
 * The sticky page heading every page shares, so the three of them read as one
 * app. Ported in shape from `apps/legacy project`'s `components/pm/toolbar.tsx`.
 */
export function Toolbar({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="sticky top-0 z-10 flex flex-wrap items-center gap-3 border-b bg-background/85 px-8 py-4 backdrop-blur">
      <span className="mr-1.5 text-lg font-bold tracking-tight">{title}</span>
      {children}
    </div>
  );
}
