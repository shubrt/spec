import { createFileRoute, useNavigate, useSearch } from "@tanstack/react-router";
import { useMemo } from "react";
import { Box } from "~/components/zpecs/box";
import { HistoricStatus } from "~/components/zpecs/historic-status";
import {
  ClearFilters,
  DateField,
  FilterBar,
  PlainSelect,
  SearchSelect,
} from "~/components/zpecs/controls";
import { EntityTable, type Column } from "~/components/zpecs/entity-table";
import { Inspector } from "~/components/zpecs/inspector";
import { PageHead } from "~/components/zpecs/parts";
import { revisionKindLabel, revisionKindTone } from "~/components/zpecs/revision-diff";
import { Screen } from "~/components/zpecs/screen";
import { revisionRef, useEntityNav } from "~/lib/entityNav";
import type { ProjectModel } from "~/lib/model";
import {
  actorTally,
  applyRevisionFilters,
  reasonCount,
  toRevisionEntries,
  type RevisionEntry,
} from "~/lib/revisions";
import { carry, type RootSearch } from "~/lib/search";
import { formatRevisionTime, keySequence } from "~/lib/vocabulary";
import { getRevisions } from "~/server/revisions";

/**
 * Recent changes — an immutable revision surface.
 *
 * One table. Grouping by day cut the log into several tables with several
 * paginations and several sort states, so a range crossing midnight could not be
 * read in order. The day is a column now and the range lives in the filter.
 *
 * A revision is immutable and numbered. It is not an activity feed: there is
 * nothing here to approve, comment on or restore, and nothing tracks what you have
 * already seen — all of that would need capabilities this product does not have.
 *
 * One recorded reason often writes revisions on several entities at once. They are
 * deliberately not collapsed into a change set: the database stores no batch, and
 * drawing one would invent a unit of review nobody can open or revert. The drawer
 * names the siblings instead.
 */

interface ChangesSearch extends RootSearch {
  readonly from?: string;
  readonly to?: string;
  readonly type?: string;
  readonly kind?: string;
  readonly actor?: string;
  readonly entity?: string;
}

export const Route = createFileRoute("/changes")({
  validateSearch: (search: Record<string, unknown>): ChangesSearch => ({
    project: typeof search.project === "string" ? search.project : undefined,
    workspace: typeof search.workspace === "string" ? search.workspace : undefined,
    inspect: typeof search.inspect === "string" ? search.inspect : undefined,
    from: typeof search.from === "string" ? search.from : undefined,
    to: typeof search.to === "string" ? search.to : undefined,
    type: typeof search.type === "string" ? search.type : undefined,
    kind: typeof search.kind === "string" ? search.kind : undefined,
    actor: typeof search.actor === "string" ? search.actor : undefined,
    entity: typeof search.entity === "string" ? search.entity : undefined,
  }),
  loaderDeps: ({ search }) => ({ project: search.project }),
  // `?project=` may be absent, in which case the server function falls back to the
  // same first-project rule the board loader uses. Only this screen loads the log.
  loader: ({ deps }) => getRevisions({ data: deps.project }),
  component: ChangesPage,
});

function ChangesPage() {
  return <Screen>{(model) => <ChangesScreen model={model} />}</Screen>;
}

const FILTER_KEYS = ["from", "to", "type", "kind", "actor", "entity"] as const;

const ENTITY_TYPES = [
  ["epic", "Epics"],
  ["stream", "Streams"],
  ["task", "Tasks"],
  ["rule", "Rules"],
  ["milestone", "Milestones"],
] as const;

const CHANGE_KINDS = [
  ["created", "Created"],
  ["status", "Status"],
  ["structure", "Structure"],
  ["text", "Text only"],
] as const;

function ChangesScreen({ model }: { readonly model: ProjectModel }) {
  const nav = useEntityNav();
  const search = Route.useSearch();
  const rootSearch = useSearch({ from: "__root__" });
  const navigate = useNavigate({ from: Route.fullPath });
  const loaded = Route.useLoaderData();

  const all = useMemo(() => toRevisionEntries(loaded.revisions), [loaded.revisions]);
  const rows = applyRevisionFilters(all, search);
  const activeFilters = FILTER_KEYS.filter((key) => search[key] !== undefined).length;

  const set = (patch: Partial<ChangesSearch>) => {
    void navigate({ search: (previous) => ({ ...previous, ...patch }) });
  };

  const actors = actorTally(all);
  const reasons = reasonCount(all);
  const days = all.map((entry) => entry.day).filter((day) => day.length > 0);
  const earliest = days.length > 0 ? days.reduce((min, day) => (day < min ? day : min)) : undefined;
  const latest = days.length > 0 ? days.reduce((max, day) => (day > max ? day : max)) : undefined;

  const entityOptions = [
    ...model.epics.map((row) => ({ key: row.key, label: row.title })),
    ...model.streams.map((row) => ({ key: row.key, label: row.title })),
    ...model.tasks.map((row) => ({ key: row.key, label: row.title })),
  ];

  return (
    <div>
      <PageHead
        title="Recent changes"
        count={
          rows.length === all.length ? all.length : `${String(rows.length)} / ${String(all.length)}`
        }
        hint="Every stored Entity Revision, newest first. A revision is immutable and numbered; it is not an activity post. There is nothing here to approve, comment on or restore, and nothing tracks what you have already seen."
      >
        <ClearFilters
          count={activeFilters}
          onClear={() => {
            void navigate({ search: (previous) => carry(previous) });
          }}
        />
      </PageHead>

      <FilterBar>
        <DateField
          label="From"
          value={search.from}
          min={earliest}
          max={latest}
          onChange={(value) => set({ from: value })}
        />
        <DateField
          label="To"
          value={search.to}
          min={earliest}
          max={latest}
          onChange={(value) => set({ to: value })}
        />
        <PlainSelect
          label="Type"
          value={search.type}
          width={124}
          options={ENTITY_TYPES}
          onChange={(value) => set({ type: value })}
        />
        <PlainSelect
          label="Change"
          value={search.kind}
          width={124}
          options={CHANGE_KINDS}
          onChange={(value) => set({ kind: value })}
        />
        <PlainSelect
          label="By"
          value={search.actor}
          width={180}
          options={actors.map(
            (entry) => [entry.actor, `${entry.actor} · ${String(entry.count)}`] as const,
          )}
          onChange={(value) => set({ actor: value })}
        />
        <SearchSelect
          label="Entity"
          value={search.entity}
          width={110}
          align="right"
          options={entityOptions}
          onChange={(value) => set({ entity: value })}
        />
      </FilterBar>

      <div className="text-muted-foreground py-2 text-[11px]">
        {`${String(reasons)} recorded reasons stand behind ${String(all.length)} revisions — one reason often rewrites several entities at once. They stay separate on purpose: no change set is stored, so there is no batch to collapse them into.`}
      </div>

      <EntityTable
        label="Entity Revisions"
        columns={revisionColumns()}
        rows={rows}
        selectedKey={rootSearch.inspect}
        onSelect={(key) => {
          const entry = rows.find((candidate) => candidate.key === key);
          if (entry) nav.inspect(revisionRef(entry.entityKey, entry.revision));
        }}
        defaultOrderLabel="Newest first · select a revision to open its diff"
        emptyLabel="No revision matches this filter"
        emptyHint="The filter is URL state, so this empty range is shareable. Clear it to see the whole log."
        initialPageSize={25}
      />

      {/* Resolving a revision needs the log, and only this screen loads it — so
          this screen mounts the revision-scoped Inspector. The one in the frame
          owns every other target and ignores `rev:`, so only one is ever open. */}
      <Inspector model={model} scope="revision" revisions={all} />
    </div>
  );
}

function revisionColumns(): readonly Column<RevisionEntry>[] {
  return [
    {
      id: "when",
      label: "When",
      width: 168,
      cellClass: "text-muted-foreground font-mono text-xs tabular-nums",
      sort: (row) => row.createdAt,
      render: (row) => formatRevisionTime(row.createdAt),
      hint: "When the revision was recorded. The only kind of time this product stores — never a due date, a deadline or a scheduled position.",
    },
    {
      id: "entity",
      label: "Entity",
      width: 72,
      sort: (row) => keySequence(row.entityKey),
      render: (row) => <span className="font-mono text-xs font-medium">{row.entityKey}</span>,
    },
    {
      id: "title",
      label: "Title",
      flex: true,
      sort: (row) => row.title,
      render: (row) => <span className="line-clamp-1 text-xs">{row.title}</span>,
      hint: "The title as this revision left it, read from the snapshot — so a renamed entity reads under the name it had at the time.",
    },
    {
      id: "kind",
      label: "Change",
      width: 160,
      sort: (row) => row.kind,
      hint: "Created is the first revision. Status means the stored status moved, and shows the status it moved to. Structure means a section gained or lost entries. Text only means the revision exists but no section count moved — wording inside a clause, or a field that is a column rather than document JSON.",
      render: (row) =>
        row.kind === "status" ? (
          <HistoricStatus status={row.status} />
        ) : (
          <Box tone={revisionKindTone(row.kind)}>
            {row.kind === "structure"
              ? `${String(row.sectionDeltas.length)} section${row.sectionDeltas.length === 1 ? "" : "s"}`
              : revisionKindLabel(row.kind).toLowerCase()}
          </Box>
        ),
    },
    {
      id: "reason",
      label: "Reason",
      flex: true,
      cellClass: "text-muted-foreground text-xs",
      sort: (row) => row.changeReason ?? "",
      render: (row) => <span className="line-clamp-1">{row.changeReason ?? "—"}</span>,
      hint: "Why the change was made, in the author's words. Optional on the row, so a dash means none was recorded.",
    },
    {
      id: "actor",
      label: "By",
      width: 132,
      cellClass: "text-muted-foreground font-mono text-[11px]",
      sort: (row) => row.changedBy,
      render: (row) => <span className="truncate">{row.changedBy}</span>,
      hint: "The actor id stored on the revision. It is the only identity zpecs has ever written down — names and emails live in Clerk.",
    },
    {
      id: "revision",
      label: "Revision",
      width: 92,
      align: "right",
      cellClass: "text-muted-foreground font-mono text-xs tabular-nums",
      sort: (row) => row.revision,
      render: (row) =>
        `${row.revision > 1 ? String(row.revision - 1) : "—"} → ${String(row.revision)}`,
      hint: "Before and after. Revision 1 has no predecessor, so it reads — → 1.",
    },
  ];
}
