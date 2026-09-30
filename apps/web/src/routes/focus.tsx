import { createFileRoute, useNavigate, useSearch } from "@tanstack/react-router";
import { AbsentBox, Box, DependencyCell, StatusCell } from "~/components/spec/box";
import {
  colKey,
  colPriority,
  colTitle,
  streamColumns,
  taskColumns,
} from "~/components/spec/columns";
import { EntityTable, countCell, type Column } from "~/components/spec/entity-table";
import { EmptyState, EntityKey, PageHead, SubHead, TableNote, Tabs } from "~/components/spec/parts";
import { Screen } from "~/components/spec/screen";
import { useEntityNav, type EntityNav } from "~/lib/entityNav";
import type { ProjectModel, StreamRow } from "~/lib/model";
import type { RootSearch } from "~/lib/search";
import { formatRevisionTime, keySequence } from "~/lib/vocabulary";
import { getFragments } from "~/server/fragments";

/**
 * Focus — seven answers, one per tab, one table each.
 *
 * Every tab projects the same row shapes the Streams and Tasks screens use, so a
 * Task looks like a Task wherever a lead meets it. The tab is the sub-page: it
 * lives in the URL and survives navigating away and back.
 *
 * The page carries exactly one h1. The tab strip already names the sub-page and the
 * breadcrumb repeats it, so the line under the tabs says the thing neither of them
 * does — what the number actually counts.
 *
 * ## Nothing here is a queue
 *
 * Every tab is a projection over stored status and the stored dependency graph,
 * computed on load. There is no ranking service behind it, no cap, and no promise
 * of completeness beyond "this is what the data says right now". The captions say
 * so, because "ready" that turns out to mean "ready according to something you
 * cannot inspect" is the most expensive kind of wrong on a screen like this.
 */

const TABS = [
  { id: "continue", label: "Continue work" },
  { id: "ready", label: "Ready now" },
  { id: "decompose", label: "Needs decomposition" },
  { id: "blocked", label: "Blocked" },
  { id: "parallel", label: "Parallel" },
  { id: "questions", label: "Open questions" },
  { id: "revisions", label: "Recently changed" },
] as const;

type TabId = (typeof TABS)[number]["id"];

const CAPTION: Record<TabId, string> = {
  continue: "Tasks whose stored status is in progress",
  ready: "Tasks that could be picked up now",
  decompose: "Streams that are ready or in progress and have no Tasks yet",
  blocked: "Held by an unfinished prerequisite, never by a stored status",
  parallel: "Nothing in the dependency graph forces an order between these",
  questions: "Open questions stored on a Stream or a Task, each with its owner",
  revisions: "Ordered by the stored revision timestamp, most recently rewritten first",
};

const HINT: Record<TabId, string> = {
  continue:
    "Tasks that store in_progress. A Task can be in progress and held by a blocker at the same time — the two are separate signals and both are shown.",
  ready:
    "Derived at read time: an active Epic, a Stream that is ready or in progress with nothing holding it, and a Task in the same state with no unfinished prerequisite of its own. Not a stored flag, not ranked, and not capped.",
  decompose:
    "A Stream that is ready to be worked but has no technical breakdown yet. Streams whose only Tasks are drafts are included, because a draft Task is not yet work anybody can pick up.",
  blocked:
    "Stored status and dependency blocking are two different signals. Several rows here still read Ready or In progress — that is their stored status, and it is correct; what holds them is a prerequisite, shown in its own column.",
  parallel:
    "The first derived Dependency Wave: Streams with no unsatisfied prerequisite in the graph. Waves are computed on load and are not stored entities. Equal wave does not mean merge-safe and does not mean concurrently active — only that nothing forces an order.",
  questions:
    "Every open question recorded on a Stream or a Task. Each local key is shown with its owner, because a fragment key is only unique inside the entity that holds it.",
  revisions:
    "The stored revision timestamp, which says when an entity was last rewritten. It is not a due date — spec stores no dates of any other kind.",
};

interface FocusSearch extends RootSearch {
  readonly tab?: TabId;
}

export const Route = createFileRoute("/focus")({
  validateSearch: (search: Record<string, unknown>): FocusSearch => ({
    project: typeof search.project === "string" ? search.project : undefined,
    workspace: typeof search.workspace === "string" ? search.workspace : undefined,
    inspect: typeof search.inspect === "string" ? search.inspect : undefined,
    tab: TABS.some((tab) => tab.id === search.tab) ? (search.tab as TabId) : undefined,
  }),
  loaderDeps: ({ search }) => ({ projectId: search.project, tab: search.tab }),
  // Only the questions tab needs fragments, so only it asks — and it asks for that
  // one section rather than for the project's documents.
  loader: ({ deps }) =>
    deps.tab === "questions"
      ? getFragments({
          data: {
            projectId: deps.projectId,
            section: "open_questions",
            limit: 200,
          },
        })
      : null,
  component: FocusPage,
});

function FocusPage() {
  return <Screen>{(model) => <FocusScreen model={model} />}</Screen>;
}

interface QuestionRow {
  readonly key: string;
  readonly owner: string;
  readonly fragmentId: string;
  readonly question: string;
  readonly ownerTitle: string;
}

function FocusScreen({ model }: { readonly model: ProjectModel }) {
  const nav = useEntityNav();
  const search = Route.useSearch();
  const rootSearch = useSearch({ from: "__root__" });
  const navigate = useNavigate({ from: Route.fullPath });
  const tab: TabId = search.tab ?? "ready";

  const continuing = model.tasks.filter((row) => row.status === "in_progress");
  const ready = model.tasks.filter((row) => row.executable && row.status !== "in_progress");
  const decompose = model.streams.filter(
    (row) =>
      (row.status === "ready" || row.status === "in_progress") &&
      model.tasks.filter((task) => task.streamKey === row.key && task.status !== "draft").length ===
        0,
  );
  const blocked = model.streams.filter((row) => row.dependency.kind === "blocked");
  const blockedTasks = model.tasks.filter(
    (row) => row.dependency.kind === "blocked" || row.streamBlocked,
  );
  const parallel = (model.waves[0] ?? []).flatMap((key) => {
    const stream = model.streamByKey.get(key);
    return stream ? [stream] : [];
  });
  // Open questions are a page of the fragment endpoint, filtered to that section —
  // the one tab that needs fragments asks for them, and only when it is open.
  const questionPage = Route.useLoaderData();
  const questions = (questionPage?.fragments ?? []).map(
    (fragment): QuestionRow => ({
      key: fragment.anchor,
      owner: fragment.owner,
      fragmentId: fragment.id,
      question: fragment.shape.kind === "statement" ? fragment.shape.text : "",
      ownerTitle: fragment.ownerTitle,
    }),
  );
  const recent = [...model.streams]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, 15);

  const counts: Record<TabId, number | undefined> = {
    continue: continuing.length,
    ready: ready.length,
    decompose: decompose.length,
    blocked: blocked.length,
    parallel: parallel.length,
    // The aggregate deliberately carries only the total fragment count. Avoid an
    // otherwise unused project-wide document scan just to decorate an inactive tab.
    questions: questionPage?.total,
    revisions: recent.length,
  };

  const setTab = (next: string) => {
    void navigate({ search: (previous) => ({ ...previous, tab: next as TabId }) });
  };

  return (
    <div>
      <PageHead
        title="Focus"
        hint="Seven projections over the same stored data: statuses, the dependency graph and the documents. Nothing here is ranked by a service and nothing is capped — each tab is exactly what its caption says it counts."
      />

      <Tabs
        tabs={TABS.map((entry) => ({ id: entry.id, label: entry.label, count: counts[entry.id] }))}
        value={tab}
        onChange={setTab}
      />

      <SubHead caption={CAPTION[tab]} count={counts[tab]} hint={HINT[tab]} />

      {tab === "continue" ? (
        continuing.length > 0 ? (
          <EntityTable
            label="Work in progress"
            columns={taskColumns(nav)}
            rows={continuing}
            selectedKey={rootSearch.inspect}
            onSelect={nav.inspect}
            emptyLabel="Nothing is in progress"
          />
        ) : (
          <EmptyState
            label="No Task stores the status in progress"
            hint="Nothing is currently being worked on. That is a statement about stored status, not about whether work could start — the Ready now tab answers that."
          />
        )
      ) : null}

      {tab === "ready" ? (
        <EntityTable
          label="Ready now"
          columns={taskColumns(nav)}
          rows={ready}
          selectedKey={rootSearch.inspect}
          onSelect={nav.inspect}
          defaultOrderLabel="Ordered by stored status, then priority and key. This is an order to read in, not a queue to work through."
          emptyLabel="Nothing could start right now"
          emptyHint="Every Task is either finished, held by a prerequisite, still a draft, or under a Stream that is not ready. The Blocked tab separates the third case from the rest."
        />
      ) : null}

      {tab === "decompose" ? (
        <EntityTable
          label="Streams needing decomposition"
          columns={streamColumns(nav, { hideMilestone: true })}
          rows={decompose}
          selectedKey={rootSearch.inspect}
          onSelect={nav.inspect}
          emptyLabel="Nothing is waiting to be broken down"
          emptyHint="Every Stream that is ready or in progress already has at least one Task that is not a draft."
        />
      ) : null}

      {tab === "blocked" ? (
        <div>
          <TableNote
            items={[
              {
                value: model.streams.filter((row) => row.status === "blocked").length,
                label: "carry the stored status blocked",
                hint: "The stored status `blocked` and dependency blocking are different things. A Stream can be held by a prerequisite while storing Ready, and it can store blocked for a reason that has no edge behind it at all.",
              },
              { value: blocked.length, label: "Streams held", tone: "danger" },
              {
                value: blockedTasks.length,
                label: "Tasks held",
                tone: "danger",
                hint: "A Task is held either by its own unfinished prerequisite or because its parent Stream is. Both are read from the stored dependency graph.",
              },
            ]}
          />
          <EntityTable
            label="Blocked Streams"
            columns={blockedColumns(nav)}
            rows={blocked}
            selectedKey={rootSearch.inspect}
            onSelect={nav.inspect}
            defaultOrderLabel="Select a row to see the prerequisites holding it"
            emptyLabel="Nothing is held by a prerequisite"
          />
        </div>
      ) : null}

      {tab === "parallel" ? (
        <div>
          <TableNote
            items={[
              {
                value: "Wave 1",
                label: "derived grouping",
                hint: "Computed from the dependency graph at read time. Waves are not stored entities, and an equal wave means only that nothing forces an order between two Streams.",
              },
              { value: model.waves.length, label: "waves in total" },
              {
                value: model.collisions.length,
                label: "possible scope collisions",
                hint: "Pairs of open Tasks in the same wave sharing at least two technical scopes. A warning that they may touch the same code — never a detected conflict, because nothing here has been executed. The full list is on the Roadmap.",
              },
            ]}
          />
          <EntityTable
            label="Structurally parallel Streams"
            columns={streamColumns(nav, { hideMilestone: true })}
            rows={parallel}
            selectedKey={rootSearch.inspect}
            onSelect={nav.inspect}
            emptyLabel="No Stream is in the dependency graph"
            emptyHint="A Stream with no stored dependency at either end is not early — it simply has nothing to wait for, so no wave can hold it honestly."
          />
        </div>
      ) : null}

      {tab === "questions" ? (
        <div>
          <TableNote
            items={[
              { value: questions.length, label: "open questions across the Project" },
              {
                value: questionPage?.total ?? questions.length,
                label: "recorded across the Project",
                hint: "Counted by the API over every Epic, Stream, Task and Milestone document. An open question is how an author records what is known to be unknown instead of inventing an answer.",
              },
            ]}
          />
          <EntityTable
            label="Open questions"
            columns={questionColumns(nav)}
            rows={questions}
            defaultOrderLabel="Read-only — the owner key is the link"
            emptyLabel="No open question is recorded"
            emptyHint="An open question is how an author records what is known to be unknown instead of inventing an answer. None being recorded is not the same as nothing being uncertain."
          />
        </div>
      ) : null}

      {tab === "revisions" ? (
        <EntityTable
          label="Recently changed Streams"
          columns={recentColumns(nav)}
          rows={recent}
          selectedKey={rootSearch.inspect}
          onSelect={nav.inspect}
          defaultOrderLabel="The fifteen most recently rewritten Streams · the full log is on Recent changes"
          emptyLabel="No Streams"
        />
      ) : null}
    </div>
  );
}

function blockedColumns(nav: EntityNav): readonly Column<StreamRow>[] {
  return [
    colKey<StreamRow>(nav),
    colTitle<StreamRow>(),
    {
      id: "epic",
      label: "Epic",
      width: 56,
      cellClass: "text-muted-foreground font-mono text-xs",
      sort: (row) => keySequence(row.epicKey),
      render: (row) => row.epicKey,
    },
    {
      id: "status",
      label: "Stored status",
      width: 124,
      sort: (row) => row.status,
      render: (row) => <StatusCell status={row.status} muted />,
      hint: "Quiet on every row here, because on a blocked row the blocker is the thing that answers why the work is not moving. The status is still what the entity stores.",
    },
    {
      id: "dependency",
      label: "Blocked by",
      width: 116,
      sort: (row) => -(row.dependency.kind === "blocked" ? row.dependency.openCount : 0),
      render: (row) => <DependencyCell dependency={row.dependency} />,
    },
    {
      id: "blockers",
      label: "Prerequisites",
      flex: true,
      render: (row) => (
        <span className="flex flex-wrap items-center gap-1.5">
          {row.blockedBy.map((blocker) => (
            <span key={blocker.key} className="inline-flex items-center gap-1">
              <EntityKey
                entityKey={blocker.key}
                onClick={(event) => {
                  event.stopPropagation();
                  nav.inspect(blocker.key);
                }}
                className={blocker.satisfied ? "text-muted-foreground" : ""}
              />
              {blocker.satisfied ? (
                <AbsentBox label="satisfied" />
              ) : (
                <Box tone="danger" marker="⊘">
                  {blocker.status}
                </Box>
              )}
            </span>
          ))}
        </span>
      ),
      hint: "Shown prerequisite → dependent. A prerequisite that reaches its terminal success state is satisfied and stops holding the work; a cancelled one does not, because abandoning it does not deliver what depended on it.",
    },
    {
      id: "tasks",
      label: "Tasks",
      width: 76,
      align: "right",
      sort: (row) => row.taskCount,
      render: (row) => countCell(row.taskCount),
      hint: "All of them are hidden from executable work while the Stream is held, whatever their own status says.",
    },
    colPriority<StreamRow>(),
  ];
}

function recentColumns(nav: EntityNav): readonly Column<StreamRow>[] {
  return [
    colKey<StreamRow>(nav),
    colTitle<StreamRow>(),
    {
      id: "status",
      label: "Status",
      width: 124,
      sort: (row) => row.status,
      render: (row) => <StatusCell status={row.status} muted={row.dependency.kind === "blocked"} />,
    },
    {
      id: "dependency",
      label: "Blocked by",
      width: 116,
      render: (row) => <DependencyCell dependency={row.dependency} />,
    },
    {
      id: "updated",
      label: "Last rewritten",
      width: 168,
      align: "right",
      cellClass: "text-muted-foreground font-mono text-xs tabular-nums",
      sort: (row) => row.updatedAt,
      render: (row) => formatRevisionTime(row.updatedAt),
      hint: "The stored revision timestamp. It says when the entity was last rewritten — it is not a due date, and spec stores no dates of any other kind.",
    },
    {
      id: "revision",
      label: "Revision",
      width: 88,
      align: "right",
      cellClass: "text-muted-foreground font-mono text-xs tabular-nums",
      sort: (row) => row.revision,
      render: (row) => `rev ${String(row.revision)}`,
    },
  ];
}

function questionColumns(nav: EntityNav): readonly Column<QuestionRow>[] {
  return [
    {
      id: "owner",
      label: "Owner",
      width: 64,
      sort: (row) => keySequence(row.owner),
      render: (row) => <EntityKey entityKey={row.owner} onClick={() => nav.inspect(row.owner)} />,
      hint: "The Stream or Task that holds this question. A fragment lives inside its owner — it is not a project-level object.",
    },
    {
      id: "ownerTitle",
      label: "Owner title",
      width: 200,
      cellClass: "text-muted-foreground text-xs",
      sort: (row) => row.ownerTitle,
      render: (row) => row.ownerTitle,
    },
    {
      id: "fragment",
      label: "Fragment",
      width: 96,
      cellClass: "text-muted-foreground font-mono text-xs",
      sort: (row) => row.fragmentId,
      render: (row) => row.fragmentId,
      hint: "A local id, unique only inside its owner. OQ-1 exists in as many entities as have an open question.",
    },
    {
      id: "question",
      label: "Question",
      flex: true,
      cellClass: "text-xs",
      sort: (row) => row.question,
      render: (row) => row.question,
    },
  ];
}
