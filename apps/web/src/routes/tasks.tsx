import { createFileRoute, useNavigate, useSearch } from "@tanstack/react-router";
import { openColumn, taskColumns } from "~/components/spec/columns";
import {
  ClearFilters,
  FilterBar,
  FilterToggle,
  PlainSelect,
  SearchSelect,
} from "~/components/spec/controls";
import { EntityTable } from "~/components/spec/entity-table";
import { PageHead } from "~/components/spec/parts";
import { Screen } from "~/components/spec/screen";
import { useEntityNav } from "~/lib/entityNav";
import type { ProjectModel, TaskRow } from "~/lib/model";
import { carry, type RootSearch } from "~/lib/search";
import { EXECUTOR_KIND, TASK_STATUS, label } from "~/lib/vocabulary";

/**
 * Tasks — one technical unit of work under a Stream.
 *
 * A Task holds how something is built and nothing about why. Its business targets
 * live in the parent Stream and are referenced, never restated, which is what the
 * Implements column counts.
 */

interface TaskSearch extends RootSearch {
  readonly stream?: string;
  readonly status?: string;
  readonly executor?: string;
  readonly executable?: boolean;
  readonly blocked?: boolean;
}

export const Route = createFileRoute("/tasks")({
  validateSearch: (search: Record<string, unknown>): TaskSearch => ({
    project: typeof search.project === "string" ? search.project : undefined,
    workspace: typeof search.workspace === "string" ? search.workspace : undefined,
    inspect: typeof search.inspect === "string" ? search.inspect : undefined,
    stream: typeof search.stream === "string" ? search.stream : undefined,
    status: typeof search.status === "string" ? search.status : undefined,
    executor: typeof search.executor === "string" ? search.executor : undefined,
    executable: search.executable === true || search.executable === "true" ? true : undefined,
    blocked: search.blocked === true || search.blocked === "true" ? true : undefined,
  }),
  component: TasksPage,
});

function TasksPage() {
  return <Screen>{(model) => <TasksScreen model={model} />}</Screen>;
}

const FILTER_KEYS = ["stream", "status", "executor", "executable", "blocked"] as const;

function TasksScreen({ model }: { readonly model: ProjectModel }) {
  const nav = useEntityNav();
  const search = Route.useSearch();
  const rootSearch = useSearch({ from: "__root__" });
  const navigate = useNavigate({ from: Route.fullPath });

  const set = (patch: Partial<TaskSearch>) => {
    void navigate({ search: (previous) => ({ ...previous, ...patch }) });
  };

  const rows = model.tasks.filter((row) => matches(row, search));
  const activeFilters = FILTER_KEYS.filter((key) => search[key] !== undefined).length;
  const unspecified = model.tasks.filter((row) => row.executor === null).length;

  return (
    <div>
      <PageHead
        title="Tasks"
        count={
          rows.length === model.tasks.length
            ? model.tasks.length
            : `${String(rows.length)} / ${String(model.tasks.length)}`
        }
        hint="A Task is one technical unit of work under a Stream: frameworks, files, endpoints, migrations and test strategy. Business requirements stay in the Stream and are referenced from here rather than repeated."
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
          count={model.tasks.filter((row) => row.executable).length}
          onToggle={() => set({ executable: search.executable ? undefined : true })}
          title="Ready or in progress, under a Stream that is itself ready and unblocked. Derived at read time from stored status and the dependency graph — not a stored flag and not a queue."
        />
        <FilterToggle
          label="Held by a blocker"
          active={search.blocked === true}
          count={
            model.tasks.filter((row) => row.dependency.kind === "blocked" || row.streamBlocked)
              .length
          }
          onToggle={() => set({ blocked: search.blocked ? undefined : true })}
          title="Held by its own prerequisite or by one on its parent Stream"
        />
        <SearchSelect
          label="Stream"
          value={search.stream}
          width={110}
          options={model.streams.map((stream) => ({ key: stream.key, label: stream.title }))}
          onChange={(value) => set({ stream: value })}
        />
        <PlainSelect
          label="Status"
          value={search.status}
          width={124}
          options={TASK_STATUS.map((status) => [status, label(status)] as const)}
          onChange={(value) => set({ status: value })}
        />
        <PlainSelect
          label="Executor"
          value={search.executor}
          width={130}
          options={[
            ...EXECUTOR_KIND.map((kind) => [kind, kind] as const),
            ["unspecified", "Unspecified"] as const,
          ]}
          onChange={(value) => set({ executor: value })}
        />
        <span className="text-muted-foreground ml-auto text-[11px]">
          {`${String(unspecified)} carry no executor — that is undecided, not either`}
        </span>
      </FilterBar>

      <EntityTable
        label="Tasks"
        columns={[...taskColumns(nav), openColumn<TaskRow>(nav)]}
        rows={rows}
        selectedKey={rootSearch.inspect}
        onSelect={nav.inspect}
        defaultOrderLabel="Ordered by what could start first, then stored status, priority and key"
        emptyLabel="No Task matches this filter"
        emptyHint="The filter is URL state, so this empty result is shareable. Clear the filters to see every Task again."
      />
    </div>
  );
}

function matches(row: TaskRow, filters: TaskSearch): boolean {
  if (filters.stream && row.streamKey !== filters.stream) return false;
  if (filters.status && row.status !== filters.status) return false;
  if (filters.executor) {
    const wanted =
      filters.executor === "unspecified"
        ? row.executor === null
        : row.executor === filters.executor;
    if (!wanted) return false;
  }
  if (filters.executable && !row.executable) return false;
  if (filters.blocked && row.dependency.kind !== "blocked" && !row.streamBlocked) return false;
  return true;
}
