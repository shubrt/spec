import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Absent } from "~/components/zpecs/box";
import { ChipFilter, ClearFilters, FilterBar, SearchField } from "~/components/zpecs/controls";
import { EntityTable, type Column } from "~/components/zpecs/entity-table";
import { EntityKey, PageHead } from "~/components/zpecs/parts";
import { Screen } from "~/components/zpecs/screen";
import { useEntityNav, type EntityNav } from "~/lib/entityNav";
import { SECTION_ORDER, fragmentText, isTargetable, sectionLabel } from "~/lib/fragments";
import { carry, type RootSearch } from "~/lib/search";
import { keySequence } from "~/lib/vocabulary";
import { getFragments, type FragmentEntry } from "~/server/fragments";

/**
 * Requirements & Criteria — every addressable fragment in the Project, with its owner.
 *
 * ## Paged by the server
 *
 * A fragment is not a row: it lives inside a document as jsonb. This screen used to be
 * possible only because the browser held every document in the project — which is what
 * made every *other* screen pay for this one. The API extracts and pages them now, so
 * what arrives is the twenty rows on screen plus the counts the chip row needs.
 *
 * The section counts come from the same response and describe the whole project, not
 * the page. A chip row built from the current page would offer counts that change when
 * you press one, which is worse than no counts.
 *
 * ## The owner column is never optional
 *
 * A local key like `AC-2` exists once per Stream that has two acceptance criteria, so
 * the key alone identifies nothing. `S-14#AC-2` is the only globally unique form, and
 * that is what this screen is for.
 */

interface CriteriaSearch extends RootSearch {
  readonly q?: string;
  readonly section?: string;
  readonly owner?: string;
  readonly offset?: number;
  readonly limit?: number;
}

const SEARCH_DEBOUNCE_MS = 250;

export const Route = createFileRoute("/criteria")({
  validateSearch: (search: Record<string, unknown>): CriteriaSearch => ({
    project: typeof search.project === "string" ? search.project : undefined,
    workspace: typeof search.workspace === "string" ? search.workspace : undefined,
    inspect: typeof search.inspect === "string" ? search.inspect : undefined,
    q: typeof search.q === "string" ? search.q : undefined,
    section: typeof search.section === "string" ? search.section : undefined,
    owner: typeof search.owner === "string" ? search.owner : undefined,
    offset: Number.isFinite(Number(search.offset)) ? Math.max(0, Number(search.offset)) : undefined,
    limit: Number.isFinite(Number(search.limit)) ? Number(search.limit) : undefined,
  }),
  // Every filter is a loader dependency, because filtering happens on the server:
  // changing one asks for a different page rather than hiding rows already in hand.
  loaderDeps: ({ search }) => ({
    projectId: search.project,
    offset: search.offset,
    limit: search.limit,
    section: search.section,
    owner: search.owner,
    q: search.q,
  }),
  loader: ({ deps }) => getFragments({ data: deps }),
  component: CriteriaPage,
});

function CriteriaPage() {
  return <Screen>{() => <CriteriaScreen />}</Screen>;
}

const FILTER_KEYS = ["q", "section", "owner"] as const;

function CriteriaScreen() {
  const nav = useEntityNav();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const page = Route.useLoaderData();
  const [query, setQuery] = useState(search.q ?? "");

  // Back/forward navigation and links can change the canonical URL independently
  // of this input, so the draft follows those changes.
  useEffect(() => {
    setQuery(search.q ?? "");
  }, [search.q]);

  // Filtering is server-side. Keep typing local and update the URL only after the
  // user pauses, replacing the current entry so a word does not become a stack of
  // one-character history entries.
  useEffect(() => {
    const next = query || undefined;
    if (next === search.q) return undefined;

    const timer = setTimeout(() => {
      void navigate({
        replace: true,
        search: (previous) => ({ ...previous, q: next, offset: undefined }),
      });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [navigate, query, search.q]);

  // Changing a filter resets to the first page: page four of the old result is not
  // page four of the new one, and landing past the end reads as "no matches".
  const set = (patch: Partial<CriteriaSearch>) => {
    void navigate({
      search: (previous) => ({
        ...previous,
        q: query || undefined,
        ...patch,
        offset: undefined,
      }),
    });
  };

  const activeFilters = FILTER_KEYS.filter((key) => search[key] !== undefined).length;
  const countBySection = new Map(page.sectionCounts.map((entry) => [entry.section, entry.count]));
  const corpus = page.sectionCounts.reduce((sum, entry) => sum + entry.count, 0);
  const presentSections = SECTION_ORDER.filter((section) => (countBySection.get(section) ?? 0) > 0);

  return (
    <div>
      <PageHead
        title="Requirements &amp; Criteria"
        count={page.total === corpus ? corpus : `${String(page.total)} / ${String(corpus)}`}
        hint="Every typed fragment in the Project, listed with its owner — an Epic's scope and outcomes, a Stream's requirements and criteria, a Task's open questions, a Milestone's exit criteria. A local key like AC-2 exists many times over; it only means something next to the entity that holds it. These are one-line excerpts, extracted and paged by the API; the full statement reads on the owner's page in the shape its type calls for."
      >
        <ClearFilters
          count={activeFilters}
          onClear={() => {
            setQuery("");
            void navigate({ search: (previous) => carry(previous) });
          }}
        />
      </PageHead>

      <FilterBar>
        <SearchField
          value={query || undefined}
          onChange={(value) => setQuery(value ?? "")}
          placeholder="Search anchor or text…"
          width={280}
          label="Search fragments"
        />
        {search.owner ? (
          <span className="text-muted-foreground text-[11px]">{`filtered to ${search.owner}`}</span>
        ) : null}
        <span className="text-muted-foreground ml-auto text-[11px]">
          {`${String(page.ownerCount)} owner${page.ownerCount === 1 ? "" : "s"} in this result`}
        </span>
      </FilterBar>

      <div className="border-border flex flex-wrap items-center gap-1.5 border-b py-2">
        <ChipFilter
          label="All"
          count={corpus}
          active={search.section === undefined}
          onClick={() => set({ section: undefined })}
        />
        {presentSections.map((section) => (
          <ChipFilter
            key={section}
            label={sectionLabel(section)}
            count={countBySection.get(section) ?? 0}
            active={search.section === section}
            onClick={() => set({ section: search.section === section ? undefined : section })}
          />
        ))}
      </div>

      <EntityTable
        label="Specification fragments"
        columns={fragmentColumns(nav)}
        rows={page.fragments.map((fragment) => ({ ...fragment, key: fragment.anchor }))}
        onSelect={(key) => nav.inspect(key.split("#")[0] ?? key)}
        defaultOrderLabel="Owner first, then section order, cut server-side · sorting is fixed because a column sort would reorder this page rather than the corpus"
        emptyLabel="No fragment matches this filter"
        pagination={{
          total: page.total,
          offset: page.offset,
          limit: page.limit,
          onChange: (next) => {
            void navigate({
              search: (previous) => ({ ...previous, offset: next.offset, limit: next.limit }),
            });
          },
        }}
      />
    </div>
  );
}

type FragmentRow = FragmentEntry & { readonly key: string };

function fragmentColumns(nav: EntityNav): readonly Column<FragmentRow>[] {
  return [
    {
      id: "owner",
      label: "Owner",
      width: 72,
      sort: (row) => keySequence(row.owner),
      render: (row) => (
        <EntityKey
          entityKey={row.owner}
          onClick={(event) => {
            event.stopPropagation();
            nav.inspect(row.owner);
          }}
        />
      ),
      hint: "The entity that holds this fragment — an Epic, a Stream, a Task or a Milestone. Fragments live inside their owner: they are not project-level objects and they have no page of their own.",
    },
    {
      id: "ownerTitle",
      label: "Owner title",
      width: 180,
      cellClass: "text-muted-foreground text-xs",
      render: (row) => row.ownerTitle,
    },
    {
      id: "id",
      label: "Fragment",
      width: 88,
      cellClass: "font-mono text-xs",
      render: (row) => row.id,
      hint: "The local id. Unique only inside its owner, which is why the Owner column is never dropped.",
    },
    {
      id: "section",
      label: "Kind",
      width: 168,
      cellClass: "text-muted-foreground text-xs",
      render: (row) => sectionLabel(row.section),
    },
    {
      id: "excerpt",
      label: "Excerpt",
      flex: true,
      cellClass: "text-muted-foreground text-xs",
      render: (row) => fragmentText(row),
    },
    {
      id: "implementedBy",
      label: "Implemented by",
      width: 132,
      align: "right",
      cellClass: "font-mono text-xs tabular-nums",
      // A dash is not a zero. Zero means no Task named a fragment one could have
      // named; the dash means the section is outside every `implements` namespace, so
      // no Task could ever point at it.
      render: (row) =>
        isTargetable(row.section) ? row.implementedBy.length : <Absent label="—" />,
      hint: "Tasks whose implements edge names this fragment. Zero means no Task references it, which is a fact about the references rather than a verdict on the work. A dash means the section is not a targetable namespace at all — a Task has no field that could name it.",
    },
  ];
}
