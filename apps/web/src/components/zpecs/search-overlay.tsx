import { useEffect, useMemo, useRef, useState } from "react";
import { useEntityNav } from "~/lib/entityNav";
import type { ProjectModel } from "~/lib/model";
import {
  SEARCH_RESULT_CAP,
  buildSearchIndex,
  searchProject,
  type SearchHit,
} from "~/lib/searchIndex";
import { cn } from "~/lib/utils";
import { DependencyCell, StatusCell } from "./box";
import { ExternalLinkIcon, InfoHint } from "./parts";

/**
 * Project search. Opened by the field in the context bar or by ⌘K / Ctrl+K.
 *
 * Enter opens the Inspector where you are; ⌘Enter leaves for the entity's own page.
 * Two destinations because they answer different questions — "what is this row" and
 * "take me to this thing" — and the second is also how a result stays findable
 * after the drawer is closed.
 *
 * No recents and no pins. Both need a per-user marker zpecs does not store, and a
 * remembered list that is wrong is worse than none.
 */

const GROUP_NOTE: Readonly<Record<string, string>> = {
  Rules: "A Rule opens on the Rules table with its row expanded — that is where it is explained.",
  "Spec fragments":
    "A local key like AC-2 is only unique inside its owner, so every fragment is listed with it. Enter opens the owner.",
};

function SearchRow({
  hit,
  active,
  onOpen,
  onOpenPage,
}: {
  readonly hit: SearchHit;
  readonly active: boolean;
  readonly onOpen: () => void;
  readonly onOpenPage: () => void;
}) {
  return (
    <div
      role="option"
      aria-selected={active}
      onClick={onOpen}
      className={cn(
        "border-border flex cursor-pointer items-start gap-3 border-b px-3 py-2",
        active ? "bg-accent" : "hover:bg-muted",
      )}
    >
      <span className="w-[104px] shrink-0 truncate pt-0.5 font-mono text-xs font-medium">
        {hit.display}
      </span>
      <span className="min-w-0 flex-1">
        <span className="text-ledger block truncate">{hit.title}</span>
        <span className="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-x-2 text-xs">
          <span className="font-mono">{hit.path}</span>
          <span className="text-border">·</span>
          <span>{hit.kind}</span>
          <span className="text-border">·</span>
          {/* The rule this row matched on. Without it the ordering is unfalsifiable. */}
          <span className="italic">{hit.rankLabel}</span>
        </span>
        {hit.excerpt && hit.score >= 4 ? (
          <span className="text-muted-foreground mt-1 block truncate text-xs">{hit.excerpt}</span>
        ) : null}
      </span>
      <span className="flex shrink-0 items-center gap-1.5 pt-0.5">
        {hit.blocked ? <DependencyCell dependency={{ kind: "blocked", openCount: 1 }} /> : null}
        {hit.status ? <StatusCell status={hit.status} /> : null}
        <button
          type="button"
          aria-label={`Open ${hit.target} on its own page`}
          title="Open on its own page (⌘↵)"
          onClick={(event) => {
            event.stopPropagation();
            onOpenPage();
          }}
          className="text-muted-foreground hover:text-foreground hover:bg-background focus-visible:ring-ring flex size-6 items-center justify-center rounded-sm outline-none focus-visible:ring-2"
        >
          <ExternalLinkIcon />
        </button>
      </span>
    </div>
  );
}

export function SearchOverlay({
  model,
  open,
  onClose,
}: {
  readonly model: ProjectModel;
  readonly open: boolean;
  readonly onClose: () => void;
}) {
  const nav = useEntityNav();
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  const index = useMemo(() => buildSearchIndex(model), [model]);
  const results = useMemo(() => searchProject(index, query), [index, query]);

  useEffect(() => {
    if (open) input.current?.focus();
    else {
      setQuery("");
      setCursor(0);
    }
  }, [open]);

  if (!open) return null;

  const flat = results?.flat ?? [];

  const openHit = (hit: SearchHit | undefined, ownPage: boolean) => {
    if (!hit) return;
    onClose();
    if (ownPage) nav.openPage(hit.target);
    else nav.inspect(hit.target);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setCursor(Math.min(cursor + 1, flat.length - 1));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setCursor(Math.max(cursor - 1, 0));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      openHit(flat[cursor], event.metaKey || event.ctrlKey);
    }
  };

  const scope: readonly (readonly [string, string])[] = [
    ["Public keys", "E-∗, S-∗, T-∗, M-∗ and R-∗ — stable and unique inside this Project"],
    ["Titles", "every Epic, Stream, Task, Milestone and Rule"],
    ["Rule statements", `${String(model.rules.length)} Rules, searchable by their text`],
    [
      "Spec fragments",
      `${String(model.fragments.length)} requirements, criteria, scope items, edge cases, change targets, hypotheses and questions`,
    ],
  ];

  return (
    <>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close search"
        tabIndex={-1}
        className="absolute inset-0 z-50 cursor-default bg-[oklch(0.145_0_0/0.22)]"
      />
      <div
        role="dialog"
        aria-label="Search this project"
        className="border-border-strong bg-background absolute left-1/2 top-14 z-[55] flex max-h-[720px] w-[760px] -translate-x-1/2 flex-col rounded-md border shadow-[0_12px_40px_rgba(0,0,0,0.18)]"
      >
        <div className="border-border flex items-center gap-2 border-b px-3">
          <span className="text-muted-foreground shrink-0 font-mono text-xs">
            {model.projectName}
          </span>
          <input
            ref={input}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setCursor(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="Search keys, titles and specification text…"
            aria-label="Search this project"
            className="h-12 min-w-0 flex-1 bg-transparent text-sm outline-none"
          />
          <span className="border-input text-muted-foreground shrink-0 rounded-sm border px-1 font-mono text-[11px]">
            Esc
          </span>
        </div>

        <div className="min-h-0 flex-1 overflow-auto">
          {!results ? (
            <div className="px-3 py-3">
              <div className="text-muted-foreground text-micro mb-1.5 font-mono font-semibold uppercase tracking-wider">
                What is searchable
              </div>
              <div className="border-border border-t">
                {scope.map(([name, detail]) => (
                  <div
                    key={name}
                    className="border-border flex items-baseline gap-3 border-b py-1.5"
                  >
                    <span className="w-[150px] shrink-0 text-xs">{name}</span>
                    <span className="text-muted-foreground min-w-0 flex-1 text-xs leading-[17px]">
                      {detail}
                    </span>
                  </div>
                ))}
              </div>
              <p className="text-muted-foreground mt-3 max-w-[620px] text-xs leading-[17px]">
                No recents and no pins. Both would need a per-user marker that zpecs does not store,
                and a remembered list that is wrong is worse than none.
              </p>
            </div>
          ) : flat.length === 0 ? (
            <div className="px-3 py-6">
              <div className="text-ledger">{`Nothing in ${model.projectName} matches “${query.trim()}”`}</div>
              <p className="text-muted-foreground mt-2 max-w-[620px] text-xs leading-[17px]">
                Search is scoped to this Project. Keys are minted per Project, so widening it across
                the workspace would return keys that collide — there is no cross-project projection
                to search, and this offers no button that would not work.
              </p>
            </div>
          ) : (
            <div>
              {results.groups.map((group) => (
                <div key={group.group}>
                  <div className="bg-muted border-border sticky top-0 z-10 border-b px-3 py-1.5">
                    <span className="text-muted-foreground text-micro font-mono font-semibold uppercase tracking-wider">
                      {group.group}
                    </span>
                    <span className="text-muted-foreground text-micro ml-2 font-mono tabular-nums">
                      {group.items.length}
                    </span>
                    {GROUP_NOTE[group.group] ? (
                      <span className="text-muted-foreground ml-2 text-[11px] normal-case">
                        {GROUP_NOTE[group.group]}
                      </span>
                    ) : null}
                  </div>
                  {group.items.map((hit) => {
                    const position = flat.indexOf(hit);
                    return (
                      <SearchRow
                        key={`${hit.group}:${hit.display}`}
                        hit={hit}
                        active={position === cursor}
                        onOpen={() => openHit(hit, false)}
                        onOpenPage={() => openHit(hit, true)}
                      />
                    );
                  })}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="border-border text-muted-foreground flex items-center gap-4 border-t px-3 py-2 text-[11px]">
          <span>
            <span className="font-mono">↑↓</span> move
          </span>
          <span>
            <span className="font-mono">↵</span> open in detail
          </span>
          <span>
            <span className="font-mono">⌘↵</span> open on its own page
          </span>
          <span className="ml-auto tabular-nums">
            {results
              ? results.truncated > 0
                ? `showing ${String(SEARCH_RESULT_CAP)} of ${String(results.total)} matches`
                : `${String(results.total)} of ${String(index.length)} entries`
              : `${String(index.length)} entries indexed`}
          </span>
          <InfoHint align="right" width={340}>
            Ranking runs exact key, key prefix, title, then document and fragment text, then fuzzy;
            each row names the rule it matched on and each group follows its best match. Results are
            capped at {SEARCH_RESULT_CAP} rows and the cap is stated above rather than hidden.
          </InfoHint>
        </div>
      </div>
    </>
  );
}
