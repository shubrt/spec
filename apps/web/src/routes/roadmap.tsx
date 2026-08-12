import { createFileRoute, useNavigate, useSearch } from "@tanstack/react-router";
import { Absent, AbsentBox, Box, DependencyCell, StatusCell } from "~/components/zpecs/box";
import { colKey, colPriority, colTitle } from "~/components/zpecs/columns";
import { DependencyMap } from "~/components/zpecs/dependency-map";
import { EntityTable, fractionCell, type Column } from "~/components/zpecs/entity-table";
import {
  EmptyState,
  MetricGrid,
  PageHead,
  PartHead,
  SectionHead,
  SubHead,
  TableNote,
  Tabs,
} from "~/components/zpecs/parts";
import { Screen } from "~/components/zpecs/screen";
import { SpecFragment } from "~/components/zpecs/spec-fragment";
import { useEntityNav, type EntityNav } from "~/lib/entityNav";
import type { MilestoneRow, ProjectModel, StreamRow } from "~/lib/model";
import type { RootSearch } from "~/lib/search";
import { formatRevisionTime, keySequence } from "~/lib/vocabulary";
import { getFragments, type FragmentEntry } from "~/server/fragments";

/**
 * Roadmap — Plan, Map and Brief over one derived projection. No dates anywhere.
 *
 * A Milestone is a human-curated delivery section without a date axis. Roadmap rank
 * is advisory ordering inside it, Dependency Waves are derived at read time, and
 * neither is a schedule: nothing in this product stores a date beyond the timestamp
 * on a revision.
 *
 * A Milestone is drawn as a container rather than as a heading with loose parts
 * under it — a header band and a border, so belonging is carried by the box instead
 * of by proximity.
 */

const TABS = [
  { id: "plan", label: "Plan" },
  { id: "map", label: "Map" },
  { id: "brief", label: "Brief" },
] as const;

type TabId = (typeof TABS)[number]["id"];

const CAPTION: Record<TabId, string> = {
  plan: "Milestone sections in Roadmap-rank order, with their stored exit criteria",
  map: "The stored dependency graph, grouped by derived wave",
  brief: "One readable summary per Milestone, counted from the Streams beneath it",
};

interface RoadmapSearch extends RootSearch {
  readonly tab?: TabId;
  readonly milestone?: string;
}

export const Route = createFileRoute("/roadmap")({
  validateSearch: (search: Record<string, unknown>): RoadmapSearch => ({
    project: typeof search.project === "string" ? search.project : undefined,
    workspace: typeof search.workspace === "string" ? search.workspace : undefined,
    inspect: typeof search.inspect === "string" ? search.inspect : undefined,
    tab: TABS.some((tab) => tab.id === search.tab) ? (search.tab as TabId) : undefined,
    milestone: typeof search.milestone === "string" ? search.milestone : undefined,
  }),
  loaderDeps: ({ search }) => ({ projectId: search.project, tab: search.tab }),
  // Exit criteria and Milestone questions are fragments. There are few of them, so one
  // page covers every Milestone rather than one request each. The Map is entirely
  // aggregate-backed, so entering it does not request document fragments at all.
  loader: ({ deps }) =>
    deps.tab === "map"
      ? null
      : getFragments({ data: { projectId: deps.projectId, limit: 400, section: undefined } }),
  component: RoadmapPage,
});

function RoadmapPage() {
  return <Screen>{(model) => <RoadmapScreen model={model} />}</Screen>;
}

/** One Milestone with its assigned Streams, plus the Streams nothing claimed. */
interface Section {
  readonly key: string;
  readonly title: string;
  readonly milestone: MilestoneRow | null;
  readonly streams: readonly StreamRow[];
}

function sectionsOf(model: ProjectModel): readonly Section[] {
  const sections: Section[] = model.milestones.map((milestone) => ({
    key: milestone.key,
    title: milestone.title,
    milestone,
    // Advisory rank first, and equal ranks stay equal — two Streams planned at the
    // same position do not gate each other.
    streams: model.streams
      .filter((stream) => stream.milestoneKey === milestone.key)
      .sort(
        (left, right) =>
          (left.roadmapRank ?? Number.MAX_SAFE_INTEGER) -
            (right.roadmapRank ?? Number.MAX_SAFE_INTEGER) ||
          keySequence(left.key) - keySequence(right.key),
      ),
  }));

  const unassigned = model.streams.filter((stream) => stream.milestoneKey === null);
  if (unassigned.length > 0) {
    sections.push({
      key: "unassigned",
      title: "Not assigned to a Milestone",
      milestone: null,
      streams: unassigned,
    });
  }
  return sections;
}

/** A Milestone's own fragments, out of the one page this screen loaded. */
function milestoneFragments(
  all: readonly FragmentEntry[],
  key: string,
): {
  readonly exitCriteria: readonly FragmentEntry[];
  readonly openQuestions: readonly FragmentEntry[];
} {
  const own = all.filter((fragment) => fragment.owner === key);
  return {
    exitCriteria: own.filter((fragment) => fragment.section === "exit_criteria"),
    openQuestions: own.filter((fragment) => fragment.section === "open_questions"),
  };
}

function RoadmapScreen({ model }: { readonly model: ProjectModel }) {
  const nav = useEntityNav();
  const search = Route.useSearch();
  const rootSearch = useSearch({ from: "__root__" });
  const navigate = useNavigate({ from: Route.fullPath });
  const fragmentPage = Route.useLoaderData();
  const tab: TabId = search.tab ?? "plan";

  const all = sectionsOf(model);
  const sections = search.milestone
    ? all.filter((section) => section.key === search.milestone)
    : all;

  const setTab = (next: string) => {
    void navigate({ search: (previous) => ({ ...previous, tab: next as TabId }) });
  };

  return (
    <div>
      <PageHead
        title="Roadmap"
        hint="Milestones are human-curated delivery sections without a date axis. Roadmap rank is advisory ordering, Dependency Waves are derived at read time, and neither is a schedule — this product stores no dates beyond the timestamp on a revision."
      >
        {search.milestone ? (
          <button
            type="button"
            onClick={() => {
              void navigate({ search: (previous) => ({ ...previous, milestone: undefined }) });
            }}
            className="border-input hover:bg-accent focus-visible:ring-ring inline-flex h-8 items-center rounded-md border px-3 text-xs font-medium outline-none focus-visible:ring-2"
          >
            Show every Milestone
          </button>
        ) : null}
      </PageHead>

      <Tabs
        tabs={TABS.map((entry) => ({
          id: entry.id,
          label: entry.label,
          count: entry.id === "map" ? undefined : all.length,
        }))}
        value={tab}
        onChange={setTab}
      />

      <SubHead caption={CAPTION[tab]} />

      {tab === "map" ? <DependencyMap model={model} /> : null}

      {tab !== "map" && sections.length === 0 ? (
        <EmptyState
          label="No Milestone and no unassigned Stream"
          hint="A Milestone is an advisory overlay, not an ownership tier. A Project with none is planned entirely through its Epics."
        />
      ) : null}

      {tab === "plan"
        ? sections.map((section) => (
            <PlanSection
              key={section.key}
              section={section}
              model={model}
              nav={nav}
              fragments={fragmentPage?.fragments ?? []}
              selectedKey={rootSearch.inspect}
            />
          ))
        : null}

      {tab === "brief"
        ? sections.map((section) => (
            <BriefSection
              key={section.key}
              section={section}
              model={model}
              nav={nav}
              fragments={fragmentPage?.fragments ?? []}
            />
          ))
        : null}
    </div>
  );
}

function MilestoneSection({
  section,
  children,
}: {
  readonly section: Section;
  readonly children: React.ReactNode;
}) {
  return (
    <section className="border-border-strong mb-8 rounded-md border">
      <div className="border-border-strong bg-muted/40 rounded-t-md border-b px-4 py-2.5">
        <SectionHead
          title={section.milestone ? `${section.key} · ${section.title}` : section.title}
          count={section.streams.length}
          hint={
            section.milestone?.goal ??
            "Streams with no Milestone assigned. A Milestone is an assignment, not a parent — these Streams still belong to their Epic."
          }
        >
          {section.milestone ? <StatusCell status={section.milestone.status} /> : null}
        </SectionHead>
      </div>
      <div className="px-4 pb-4 pt-3">{children}</div>
    </section>
  );
}

function PlanSection({
  section,
  model,
  nav,
  fragments,
  selectedKey,
}: {
  readonly section: Section;
  readonly model: ProjectModel;
  readonly nav: EntityNav;
  readonly fragments: readonly FragmentEntry[];
  readonly selectedKey: string | undefined;
}) {
  const own = milestoneFragments(fragments, section.key);
  const completed = section.streams.filter((row) => row.status === "completed").length;
  const blocked = section.streams.filter((row) => row.dependency.kind === "blocked").length;
  const ready = section.streams.filter(
    (row) =>
      (row.status === "ready" || row.status === "in_progress") && row.dependency.kind !== "blocked",
  ).length;
  const exitCriteria = own.exitCriteria;

  return (
    <MilestoneSection section={section}>
      <TableNote
        items={[
          {
            value: `${String(completed)}/${String(section.streams.length)}`,
            label: "Streams completed",
          },
          { value: ready, label: "ready or in progress" },
          {
            value: blocked,
            label: "held by a prerequisite",
            tone: blocked > 0 ? "danger" : undefined,
          },
          { value: exitCriteria.length, label: "exit criteria" },
        ]}
      />

      <EntityTable
        label={`Streams in ${section.key}`}
        columns={planColumns(nav, model)}
        rows={section.streams}
        selectedKey={selectedKey}
        onSelect={nav.inspect}
        initialPageSize={15}
        defaultOrderLabel="Ordered by Roadmap rank. There are no dates here, so this is a sequence and not a schedule."
        emptyLabel="No Stream is assigned to this Milestone"
      />

      {exitCriteria.length > 0 ? (
        <div className="mt-5">
          <PartHead
            title="Exit criteria"
            count={exitCriteria.length}
            hint="What has to be true before this Milestone is finished. Each criterion stores its own state — none of them is derived from Stream progress, so a Milestone whose Streams are all done can still have an open criterion."
          />
          <div className="border-border border-t">
            {exitCriteria.map((fragment) => (
              <SpecFragment key={fragment.id} fragment={fragment} />
            ))}
          </div>
        </div>
      ) : null}

      {own.openQuestions.length > 0 ? (
        <div className="mt-5">
          <PartHead title="Open questions" count={own.openQuestions.length} />
          <div className="border-border border-t">
            {own.openQuestions.map((fragment) => (
              <SpecFragment key={fragment.id} fragment={fragment} />
            ))}
          </div>
        </div>
      ) : null}
    </MilestoneSection>
  );
}

function BriefSection({
  section,
  model,
  nav,
  fragments,
}: {
  readonly section: Section;
  readonly model: ProjectModel;
  readonly nav: EntityNav;
  readonly fragments: readonly FragmentEntry[];
}) {
  const completed = section.streams.filter((row) => row.status === "completed");
  const cancelled = section.streams.filter((row) => row.status === "cancelled");
  const remaining = section.streams.filter(
    (row) => row.status !== "completed" && row.status !== "cancelled",
  );
  const blockers = section.streams.filter((row) => row.dependency.kind === "blocked");
  const streamKeys = new Set(section.streams.map((row) => row.key));
  const executable = model.tasks.filter(
    (task) => task.executable && streamKeys.has(task.streamKey),
  );
  const exitCriteria = milestoneFragments(fragments, section.key).exitCriteria;
  const met = exitCriteria.filter((fragment) => fragment.marks.state === "met").length;
  const recent = [...section.streams]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, 5);

  return (
    <MilestoneSection section={section}>
      {section.milestone ? (
        <p className="text-muted-foreground text-ledger mb-4 max-w-[820px] leading-[19px]">
          {section.milestone.goal}
        </p>
      ) : null}

      <MetricGrid
        items={[
          { value: completed.length, label: "Streams completed" },
          { value: remaining.length, label: "remaining" },
          { value: cancelled.length, label: "cancelled" },
          { value: blockers.length, label: "held by a prerequisite" },
          { value: executable.length, label: "Tasks that could start" },
          {
            value: `${String(met)}/${String(exitCriteria.length)}`,
            label: "exit criteria met",
          },
        ]}
      />

      {blockers.length > 0 ? (
        <div className="mt-5">
          <PartHead title="What is held" count={blockers.length} />
          <EntityTable
            label={`Blocked Streams in ${section.key}`}
            columns={[
              colKey<StreamRow>(nav),
              colTitle<StreamRow>(),
              {
                id: "status",
                label: "Status",
                width: 124,
                render: (row) => <StatusCell status={row.status} muted />,
              },
              {
                id: "dependency",
                label: "Blocked by",
                width: 116,
                render: (row) => <DependencyCell dependency={row.dependency} />,
              },
              colPriority<StreamRow>(),
            ]}
            rows={blockers}
            onSelect={nav.inspect}
            initialPageSize={10}
            emptyLabel="Nothing is held"
          />
        </div>
      ) : null}

      {exitCriteria.length > 0 ? (
        <div className="mt-5">
          <PartHead
            title="Exit criteria"
            count={exitCriteria.length}
            hint="Each criterion's state is stored on the criterion. It is never derived from Stream progress."
          />
          <div className="border-border border-t">
            {exitCriteria.map((fragment) => (
              <SpecFragment key={fragment.id} fragment={fragment} />
            ))}
          </div>
        </div>
      ) : null}

      <div className="mt-5">
        <PartHead
          title="Recently rewritten"
          count={recent.length}
          hint="Ordered by the stored revision timestamp on each Stream. It says when, not when by."
        />
        <EntityTable
          label={`Recent revisions in ${section.key}`}
          columns={[
            colKey<StreamRow>(nav),
            colTitle<StreamRow>(),
            {
              id: "status",
              label: "Status",
              width: 124,
              render: (row) => <StatusCell status={row.status} />,
            },
            {
              id: "updated",
              label: "Last rewritten",
              width: 168,
              align: "right",
              cellClass: "text-muted-foreground font-mono text-xs tabular-nums",
              render: (row) => formatRevisionTime(row.updatedAt),
            },
            {
              id: "revision",
              label: "Revision",
              width: 88,
              align: "right",
              cellClass: "text-muted-foreground font-mono text-xs tabular-nums",
              render: (row) => `rev ${String(row.revision)}`,
            },
          ]}
          rows={recent}
          onSelect={nav.inspect}
          initialPageSize={10}
          emptyLabel="No revisions"
        />
      </div>
    </MilestoneSection>
  );
}

function planColumns(nav: EntityNav, model: ProjectModel): readonly Column<StreamRow>[] {
  return [
    {
      id: "rank",
      label: "Rank",
      width: 72,
      cellClass: "text-muted-foreground font-mono text-xs tabular-nums",
      sort: (row) => row.roadmapRank ?? Number.MAX_SAFE_INTEGER,
      render: (row) => (row.roadmapRank === null ? <Absent /> : row.roadmapRank),
      hint: "Advisory ordering inside the Milestone. It is not a dependency — two Streams sharing a rank do not block each other, they are planned at the same position.",
    },
    colKey<StreamRow>(nav),
    colTitle<StreamRow>(),
    {
      id: "epic",
      label: "Epic",
      width: 56,
      cellClass: "text-muted-foreground font-mono text-xs",
      render: (row) => row.epicKey,
    },
    {
      id: "type",
      label: "Type",
      width: 104,
      cellClass: "text-muted-foreground text-xs",
      render: (row) => row.streamType,
    },
    {
      id: "status",
      label: "Status",
      width: 124,
      render: (row) => <StatusCell status={row.status} muted={row.dependency.kind === "blocked"} />,
    },
    {
      id: "dependency",
      label: "Blocked by",
      width: 116,
      render: (row) => <DependencyCell dependency={row.dependency} />,
    },
    {
      id: "wave",
      label: "Wave",
      width: 80,
      align: "right",
      cellClass: "text-muted-foreground font-mono text-xs tabular-nums",
      sort: (row) => model.waveOfStream.get(row.key) ?? Number.MAX_SAFE_INTEGER,
      render: (row) => {
        const wave = model.waveOfStream.get(row.key);
        return wave === undefined ? (
          <AbsentBox label="no edge" />
        ) : (
          <Box tone="quiet">{String(wave + 1)}</Box>
        );
      },
      hint: "The derived Dependency Wave, computed from the graph at read time. `no edge` means the Stream takes part in no dependency at all — which is not the same as being in the first wave.",
    },
    colPriority<StreamRow>(),
    {
      id: "tasks",
      label: "Tasks",
      width: 80,
      align: "right",
      render: (row) => fractionCell(row.tasksDone, row.taskCount),
    },
  ];
}
