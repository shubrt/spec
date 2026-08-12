import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { listPathFor } from "~/lib/navigation";
import { carry } from "~/lib/search";
import { CopyButton } from "./parts";

/**
 * The head of an entity page: where it came from, what it is called, and the chips
 * that say what state it is in.
 *
 * The trail here duplicates the breadcrumb in the context bar on purpose. The
 * context bar answers "where am I in the app"; this answers "what am I looking at",
 * and a reader scrolling a 700 px document should not have to look back up at the
 * chrome to find the way out.
 */
export function DetailHead({
  kind,
  entityKey,
  title,
  chips,
  copyText,
}: {
  readonly kind: "epic" | "stream" | "task";
  readonly entityKey: string;
  readonly title: string;
  readonly chips: ReactNode;
  /**
   * Present only where a shareable address is genuinely useful. A Stream is the
   * unit you hand to somebody else; a Task is internal to the people already in it.
   */
  readonly copyText?: string;
}) {
  const list = listPathFor(kind);
  return (
    <div className="flex flex-wrap items-start gap-3 pb-3">
      <div className="min-w-0 flex-1">
        <div className="text-muted-foreground mb-1 flex items-center gap-2 font-mono text-xs">
          <Link
            to={list}
            search={carry}
            className="hover:text-foreground focus-visible:ring-ring rounded-sm underline decoration-transparent underline-offset-2 outline-none hover:decoration-current focus-visible:ring-2"
          >
            {list.slice(1).replace(/^./, (first) => first.toUpperCase())}
          </Link>
          <span className="text-border">/</span>
          <span>{entityKey}</span>
        </div>
        <h1 className="text-[26px] font-medium leading-8 tracking-tight">{title}</h1>
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5 pt-5">
        {chips}
        {copyText ? <CopyButton text={copyText} /> : null}
      </div>
    </div>
  );
}

/** A document column beside a fixed context column, wrapping rather than clipping. */
export function DetailLayout({
  document: documentColumn,
  context,
  documentWidth = 664,
}: {
  readonly document: ReactNode;
  readonly context: ReactNode;
  readonly documentWidth?: number;
}) {
  return (
    // Wrapping is deliberate: below roughly 1300 px the context column moves under
    // the document instead of running off the edge, because clipped content reads
    // as missing content.
    <div className="flex flex-wrap gap-8 pt-5">
      <div className="shrink-0" style={{ width: documentWidth, maxWidth: "100%" }}>
        {documentColumn}
      </div>
      <div className="w-[304px] shrink-0">{context}</div>
    </div>
  );
}
