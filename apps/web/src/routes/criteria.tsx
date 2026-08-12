import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ChipFilter, ClearFilters, FilterBar, SearchField } from "~/components/zpecs/controls";
import { EntityTable, type Column } from "~/components/zpecs/entity-table";
import { Absent } from "~/components/zpecs/box";
import { EntityKey, PageHead } from "~/components/zpecs/parts";
import { Screen } from "~/components/zpecs/screen";
import { useEntityNav, type EntityNav } from "~/lib/entityNav";
import {
  SECTION_ORDER,
  fragmentAnchor,
  isTargetable,
  sectionLabel,
  type SectionId,
  type SpecFragmentModel,
} from "~/lib/fragments";
import type { ProjectModel } from "~/lib/model";
import { carry, type RootSearch } from "~/lib/search";
import { keySequence } from "~/lib/vocabulary";

/**
 * Requirements & Criteria — every addressable fragment in the Project, with its
 * owner.
 *
 * The owner column is not decoration and is never optional. A local key like `AC-2`
 * exists once per Stream that has two acceptance criteria, so the key alone
 * identifies nothing; `S-14#AC-2` is the only globally unique form, and that is what
 * this screen is for.
 *
 * The excerpt is one line. The full statement, in the shape its type calls for,
 * reads on the owner's Specification tab — a table of 650 rows is an index, and an
 * index that tries to be the document is neither.
 */

interface CriteriaSearch extends RootSearch {
  readonly q?: string;
  readonly section?: SectionId;
  readonly owner?: string;
}

export const Route = createFileRoute("/criteria")({
  validateSearch: (search: Record<string, unknown>): CriteriaSearch => ({
    project: typeof search.project === "string" ? search.project : undefined,
    workspace: typeof search.workspace === "string" ? search.workspace : undefined,
    inspect: typeof search.inspect === "string" ? search.inspect : undefined,
    q: typeof search.q === "string" ? search.q : undefined,
    section: SECTION_ORDER.includes(search.section as SectionId)
      ? (search.section as SectionId)
      : undefined,
    owner: typeof search.owner === "string" ? search.owner : undefined,
  }),
  component: CriteriaPage,
});

function CriteriaPage() {
  return <Screen>{(model) => <CriteriaScreen model={model} />}</Screen>;
}

interface FragmentRow {
  readonly key: string;
  readonly owner: string;
  readonly ownerTitle: string;
  readonly id: string;
  readonly section: SectionId;
  readonly excerpt: string;
  /** `null` where the section is outside every `implements` namespace. */
  readonly implementedBy: number | null;
}

function CriteriaScreen({ model }: { readonly model: ProjectModel }) {
  const nav = useEntityNav();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });

  const set = (patch: Partial<CriteriaSearch>) => {
    void navigate({ search: (previous) => ({ ...previous, ...patch }) });
  };

  const all = model.fragments.map((fragment): FragmentRow => {
    const anchor = fragmentAnchor(fragment.owner, fragment.id);
    return {
      key: anchor,
      owner: fragment.owner,
      ownerTitle: ownerTitleOf(model, fragment.owner),
      id: fragment.id,
      section: fragment.section,
      excerpt: excerptOf(fragment),
      implementedBy: isTargetable(fragment.section)
        ? (model.implementedBy.get(anchor)?.length ?? 0)
        : null,
    };
  });

  const needle = search.q?.trim().toLowerCase();
  const rows = all.filter((row) => {
    if (search.section && row.section !== search.section) return false;
    if (search.owner && row.owner !== search.owner) return false;
    if (needle && !`${row.key} ${row.excerpt}`.toLowerCase().includes(needle)) return false;
    return true;
  });

  const activeFilters = (["q", "section", "owner"] as const).filter(
    (key) => search[key] !== undefined,
  ).length;
  const owners = new Set(rows.map((row) => row.owner));
  const presentSections = SECTION_ORDER.filter((section) =>
    all.some((row) => row.section === section),
  );

  return (
    <div>
      <PageHead
        title="Requirements &amp; Criteria"
        count={
          rows.length === all.length ? all.length : `${String(rows.length)} / ${String(all.length)}`
        }
        hint="Every typed fragment in the Project, listed with its owner. A local key like AC-2 exists many times over — it only means something next to the Stream that holds it. These are excerpts; the full statement reads on the owner's Specification tab, in the shape its type calls for."
      >
        <ClearFilters
          count={activeFilters}
          onClear={() => {
            void navigate({ search: (previous) => carry(previous) });
          }}
        />
      </PageHead>

      <FilterBar>
        <SearchField
          value={search.q}
          onChange={(value) => set({ q: value })}
          placeholder="Search anchor or text…"
          width={280}
          label="Search fragments"
        />
      </FilterBar>

      <div className="border-border flex flex-wrap items-center gap-1.5 border-b py-2">
        <ChipFilter
          label="All"
          count={all.length}
          active={search.section === undefined}
          onClick={() => set({ section: undefined })}
        />
        {presentSections.map((section) => (
          <ChipFilter
            key={section}
            label={sectionLabel(section)}
            count={all.filter((row) => row.section === section).length}
            active={search.section === section}
            onClick={() => set({ section: search.section === section ? undefined : section })}
          />
        ))}
      </div>

      <EntityTable
        label="Specification fragments"
        columns={fragmentColumns(nav)}
        rows={rows}
        onSelect={(key) => nav.inspect(key.split("#")[0] ?? key)}
        defaultOrderLabel={`Owner first, then section order · ${String(owners.size)} owners`}
        emptyLabel="No fragment matches this filter"
        initialPageSize={20}
      />
    </div>
  );
}

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
      hint: "The entity that holds this fragment — an Epic, a Stream or a Milestone. Fragments live inside their owner: they are not project-level objects and they have no page of their own.",
    },
    {
      id: "id",
      label: "Fragment",
      width: 88,
      cellClass: "font-mono text-xs",
      sort: (row) => row.id,
      render: (row) => row.id,
      hint: "The local id. Unique only inside its owner, which is why the Owner column is never dropped.",
    },
    {
      id: "section",
      label: "Kind",
      width: 176,
      cellClass: "text-muted-foreground text-xs",
      sort: (row) => sectionLabel(row.section),
      render: (row) => sectionLabel(row.section),
    },
    {
      id: "excerpt",
      label: "Excerpt",
      flex: true,
      cellClass: "text-muted-foreground text-xs",
      sort: (row) => row.excerpt,
      render: (row) => row.excerpt,
    },
    {
      id: "implementedBy",
      label: "Implemented by",
      width: 132,
      align: "right",
      cellClass: "font-mono text-xs tabular-nums",
      sort: (row) => row.implementedBy ?? -1,
      // A dash is not a zero. Zero means no Task named a fragment that one could
      // have named; the dash means the section is outside every `implements`
      // namespace, so no Task could ever point at it.
      render: (row) => (row.implementedBy === null ? <Absent label="—" /> : row.implementedBy),
      hint: "Tasks whose implements edge names this fragment. Zero means no Task references it, which is a fact about the references rather than a verdict on the work. A dash means the section is not a targetable namespace at all — a Task has no field that could name it.",
    },
  ];
}

/** An owner can be an Epic, a Stream or a Milestone, so all three are resolved. */
function ownerTitleOf(model: ProjectModel, owner: string): string {
  return (
    model.streamByKey.get(owner)?.title ??
    model.epicByKey.get(owner)?.title ??
    model.milestoneByKey.get(owner)?.title ??
    ""
  );
}

/** One line of a fragment, whatever shape it is in. */
function excerptOf(fragment: SpecFragmentModel): string {
  const { shape } = fragment;
  switch (shape.kind) {
    case "statement":
      return shape.text;
    case "criterion":
      return `Given ${shape.given} · When ${shape.when} · Then ${shape.then}`;
    case "condition":
      return `${shape.condition} → ${shape.outcome}`;
    case "transition":
      return `${shape.from} → ${shape.to}`;
    case "workflow":
      return shape.steps.map((step) => step.action).join(" · ");
  }
}
