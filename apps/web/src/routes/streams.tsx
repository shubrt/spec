import { createFileRoute, useNavigate, useSearch } from "@tanstack/react-router";
import { openColumn, streamColumns } from "~/components/zpecs/columns";
import {
  ClearFilters,
  FilterBar,
  FilterToggle,
  PlainSelect,
  SearchSelect,
} from "~/components/zpecs/controls";
import { EntityTable } from "~/components/zpecs/entity-table";
import { PageHead } from "~/components/zpecs/parts";
import { Screen } from "~/components/zpecs/screen";
import { useEntityNav } from "~/lib/entityNav";
import type { ProjectModel, StreamRow } from "~/lib/model";
import { carry, type RootSearch } from "~/lib/search";
import { STREAM_STATUS, STREAM_TYPE, label } from "~/lib/vocabulary";

/**
 * Streams — one bounded change, problem or investigation inside an Epic.
 *
 * The filters are URL state, which is what makes a narrowed view — including an
 * empty one — shareable and reproducible rather than something only you can see.
 *
 * The quick toggles are the three questions a lead arrives with: what can start,
 * what is stuck, what is unresolved. The selects below are refinement.
 *
 * `Size` has no column. It is a real field on the Stream document, and a column of
 * empty cells for a Project that does not use it would read as missing data rather
 * than as an unused field — so it appears only where it is set.
 */

interface StreamSearch extends RootSearch {
  readonly epic?: string;
  readonly status?: string;
  readonly type?: string;
  readonly milestone?: string;
  readonly executable?: boolean;
  readonly blocked?: boolean;
}

export const Route = createFileRoute("/streams")({
  validateSearch: (search: Record<string, unknown>): StreamSearch => ({
    project: typeof search.project === "string" ? search.project : undefined,
    workspace: typeof search.workspace === "string" ? search.workspace : undefined,
    inspect: typeof search.inspect === "string" ? search.inspect : undefined,
    epic: typeof search.epic === "string" ? search.epic : undefined,
    status: typeof search.status === "string" ? search.status : undefined,
    type: typeof search.type === "string" ? search.type : undefined,
    milestone: typeof search.milestone === "string" ? search.milestone : undefined,
    executable: search.executable === true || search.executable === "true" ? true : undefined,
    blocked: search.blocked === true || search.blocked === "true" ? true : undefined,
  }),
  component: StreamsPage,
});

function StreamsPage() {
  return <Screen>{(model) => <StreamsScreen model={model} />}</Screen>;
}

const FILTER_KEYS = ["epic", "status", "type", "milestone", "executable", "blocked"] as const;

function StreamsScreen({ model }: { readonly model: ProjectModel }) {
  const nav = useEntityNav();
  const search = Route.useSearch();
  const rootSearch = useSearch({ from: "__root__" });
  const navigate = useNavigate({ from: Route.fullPath });

  const set = (patch: Partial<StreamSearch>) => {
    void navigate({ search: (previous) => ({ ...previous, ...patch }) });
  };

  const rows = model.streams.filter((row) => matches(row, search));
  const activeFilters = FILTER_KEYS.filter((key) => search[key] !== undefined).length;

  return (
    <div>
      <PageHead
        title="Streams"
        count={
          rows.length === model.streams.length
            ? model.streams.length
            : `${String(rows.length)} / ${String(model.streams.length)}`
        }
        hint="A Stream is one bounded change inside an Epic and the planning unit for the business question — what and why, never how. Its type is picked from the nature of the work rather than forced into a user-story shape."
      >
        <ClearFilters
          count={activeFilters}
          onClear={() => {
            void navigate({ search: (previous) => carry(previous) });
          }}
        />
      </PageHead>

      <FilterBar>
        <FilterToggle
          label="Could start"
          active={search.executable === true}
          count={model.streams.filter((row) => row.executable).length}
          onToggle={() => set({ executable: search.executable ? undefined : true })}
          title="Ready or in progress under an active Epic, with nothing holding it. Derived at read time, not a stored flag."
        />
        <FilterToggle
          label="Blocked"
          active={search.blocked === true}
          count={model.streams.filter((row) => row.dependency.kind === "blocked").length}
          onToggle={() => set({ blocked: search.blocked ? undefined : true })}
          title="Held by an unfinished prerequisite — separate from the stored status"
        />
        <SearchSelect
          label="Epic"
          value={search.epic}
          width={110}
          options={model.epics.map((epic) => ({ key: epic.key, label: epic.title }))}
          onChange={(value) => set({ epic: value })}
        />
        <PlainSelect
          label="Status"
          value={search.status}
          width={124}
          options={STREAM_STATUS.map((status) => [status, label(status)] as const)}
          onChange={(value) => set({ status: value })}
        />
        <PlainSelect
          label="Type"
          value={search.type}
          width={124}
          options={STREAM_TYPE.map((type) => [type, type] as const)}
          onChange={(value) => set({ type: value })}
        />
        <PlainSelect
          label="Milestone"
          value={search.milestone}
          width={130}
          anyLabel="Any"
          options={[
            ...model.milestones.map((milestone) => [milestone.key, milestone.key] as const),
            ["none", "No Milestone"] as const,
          ]}
          onChange={(value) => set({ milestone: value })}
        />
      </FilterBar>

      <EntityTable
        label="Streams"
        columns={[...streamColumns(nav), openColumn<StreamRow>(nav)]}
        rows={rows}
        selectedKey={rootSearch.inspect}
        onSelect={nav.inspect}
        defaultOrderLabel="Ordered by what could start first, then stored status, priority and key"
        emptyLabel="No Stream matches this filter"
        emptyHint="The filter is URL state, so this empty result is shareable and reproducible. Clear the filters to see every Stream again."
      />
    </div>
  );
}

function matches(row: StreamRow, filters: StreamSearch): boolean {
  if (filters.epic && row.epicKey !== filters.epic) return false;
  if (filters.status && row.status !== filters.status) return false;
  if (filters.type && row.streamType !== filters.type) return false;
  if (filters.milestone) {
    const assigned =
      filters.milestone === "none"
        ? row.milestoneKey === null
        : row.milestoneKey === filters.milestone;
    if (!assigned) return false;
  }
  if (filters.executable && !row.executable) return false;
  if (filters.blocked && row.dependency.kind !== "blocked") return false;
  return true;
}
