import type { EntityNav } from "~/lib/entityNav";
import type { EpicRow, StreamRow, TaskRow } from "~/lib/model";
import { keySequence, priorityRank, statusRank } from "~/lib/vocabulary";
import { Absent, AbsentBox, DependencyCell, ExecutorCell, PriorityCell, StatusCell } from "./box";
import { countCell, fractionCell, type Column, type TableRowShape } from "./entity-table";
import { EntityKey, ExternalLinkIcon } from "./parts";

/**
 * The column sets shared by every table that lists Epics, Streams or Tasks.
 *
 * Shared rather than declared per screen: the Epic page shows the Streams table
 * filtered to one Epic, Focus shows the Tasks table filtered to what could start,
 * and a second definition would drift from the first — which is how a Status column
 * ends up meaning two different things on two screens.
 *
 * Each hint states what the column is *and* what it is not, because most of these
 * numbers are derived and the difference between a stored field and a read-time
 * projection is exactly what a reader needs in order to trust it.
 */

const STATUS_HINT =
  "The status stored on the entity, independent of whether a dependency is holding the work — that is the Blocked by column. On a blocked row this box is deliberately quiet so the blocker is the only loud thing. A Stream reaches completed and a Task reaches done: two different stored values.";

const DEPENDENCY_HINT =
  "An unfinished prerequisite. Separate from the stored status — a Stream can be In progress and blocked at the same time. `met` means every prerequisite is satisfied; `none` means there never were any.";

const PRIORITY_HINT =
  "Business urgency from the entity document: critical, high, medium or low. Absent means nobody has set one, which is not the same as low.";

const REVISION_HINT =
  "Every change writes an immutable entity revision. This counts how often the entity was rewritten, not when — the timestamp is on Recent changes.";

const RANK_HINT =
  "Advisory ordering inside the Milestone. It is not a dependency, and two Streams sharing a rank do not block each other — they are planned at the same position.";

export function colKey<Row extends TableRowShape>(nav: EntityNav): Column<Row> {
  return {
    id: "key",
    label: "Key",
    width: 60,
    cellClass: "font-mono text-xs font-medium",
    sort: (row) => keySequence(row.key),
    render: (row) => (
      <EntityKey
        entityKey={row.key}
        onClick={(event) => {
          event.stopPropagation();
          nav.inspect(row.key);
        }}
      />
    ),
  };
}

export function colTitle<Row extends TableRowShape & { readonly title: string }>(): Column<Row> {
  return {
    id: "title",
    label: "Title",
    flex: true,
    sort: (row) => row.title,
    render: (row) => row.title,
  };
}

export function colPriority<
  Row extends TableRowShape & { readonly priority: EpicRow["priority"] },
>(): Column<Row> {
  return {
    id: "priority",
    label: "Priority",
    width: 104,
    sort: (row) => priorityRank(row.priority),
    render: (row) => <PriorityCell priority={row.priority} />,
    hint: PRIORITY_HINT,
  };
}

export function colRevision<
  Row extends TableRowShape & { readonly revision: number },
>(): Column<Row> {
  return {
    id: "revision",
    label: "Revision",
    width: 88,
    align: "right",
    cellClass: "text-muted-foreground font-mono text-xs tabular-nums",
    sort: (row) => row.revision,
    render: (row) => `rev ${String(row.revision)}`,
    hint: REVISION_HINT,
  };
}

/**
 * The row opens the Inspector; this column opens the entity's own page.
 *
 * All three levels have a page, so the icon means one thing everywhere and the
 * drawer is never the last stop.
 */
export function openColumn<Row extends TableRowShape>(nav: EntityNav): Column<Row> {
  return {
    id: "open",
    label: "",
    width: 40,
    align: "right",
    render: (row) => (
      <button
        type="button"
        aria-label={`Open ${row.key} on its own page`}
        title="Open on its own page"
        onClick={(event) => {
          event.stopPropagation();
          nav.openPage(row.key);
        }}
        className="text-muted-foreground hover:text-foreground hover:bg-background focus-visible:ring-ring inline-flex size-6 items-center justify-center rounded-sm outline-none focus-visible:ring-2"
      >
        <ExternalLinkIcon />
      </button>
    ),
  };
}

/* ------------------------------------------------------------------ Epics -- */

export function epicColumns(nav: EntityNav): readonly Column<EpicRow>[] {
  return [
    colKey<EpicRow>(nav),
    colTitle<EpicRow>(),
    {
      id: "status",
      label: "Status",
      width: 116,
      sort: (row) => statusRank(row.status),
      render: (row) => <StatusCell status={row.status} />,
      hint: "An Epic has active, paused and archived and nothing else — there is no completed Epic, because finishing one of its Streams does not finish the capability.",
    },
    {
      id: "streams",
      label: "Streams",
      width: 92,
      align: "right",
      sort: (row) => (row.streamCount === 0 ? -1 : row.streamsCompleted / row.streamCount),
      render: (row) => fractionCell(row.streamsCompleted, row.streamCount),
      hint: "Completed Streams over Streams owned. Counted here — an Epic stores no aggregates.",
    },
    {
      id: "tasks",
      label: "Tasks",
      width: 88,
      align: "right",
      sort: (row) => (row.taskCount === 0 ? -1 : row.tasksDone / row.taskCount),
      render: (row) => fractionCell(row.tasksDone, row.taskCount),
      hint: "Tasks done over Tasks in this Epic.",
    },
    {
      id: "ready",
      label: "Ready",
      width: 84,
      align: "right",
      sort: (row) => row.readyNow,
      render: (row) => countCell(row.readyNow),
      hint: "Streams that are ready or in progress and not held by an unfinished blocker.",
    },
    {
      id: "blocked",
      label: "Blocked",
      width: 104,
      align: "right",
      sort: (row) => row.blockedStreams,
      render: (row) =>
        row.blockedStreams > 0 ? (
          <span className="inline-flex justify-end">
            <DependencyCell dependency={{ kind: "blocked", openCount: row.blockedStreams }} />
          </span>
        ) : (
          countCell(0)
        ),
      hint: "Streams held behind an unfinished Stream blocker. This is dependency blocking, not a stored status.",
    },
    {
      id: "executable",
      label: "Could start",
      width: 104,
      align: "right",
      sort: (row) => row.executableTasks,
      render: (row) => countCell(row.executableTasks),
      hint: "Tasks in this Epic that could be picked up now — derived at read time from the Epic's state, the stored statuses and the dependency graph. Not a stored field and not a queue.",
    },
    colRevision<EpicRow>(),
  ];
}

/* ---------------------------------------------------------------- Streams -- */

export function streamColumns(
  nav: EntityNav,
  options: { readonly hideEpic?: boolean; readonly hideMilestone?: boolean } = {},
): readonly Column<StreamRow>[] {
  const columns: Column<StreamRow>[] = [colKey<StreamRow>(nav), colTitle<StreamRow>()];

  if (!options.hideEpic) {
    columns.push({
      id: "epic",
      label: "Epic",
      width: 56,
      cellClass: "text-muted-foreground font-mono text-xs",
      sort: (row) => keySequence(row.epicKey),
      render: (row) => row.epicKey,
    });
  }

  columns.push(
    {
      id: "type",
      label: "Type",
      width: 104,
      cellClass: "text-muted-foreground text-xs",
      sort: (row) => row.streamType,
      render: (row) => row.streamType,
      hint: "Picked from the nature of the work, never forced into a user-story shape: feature, bug, change, experiment, investigation, refactor or maintenance.",
    },
    {
      id: "status",
      label: "Status",
      width: 124,
      sort: (row) => statusRank(row.status),
      render: (row) => <StatusCell status={row.status} muted={row.dependency.kind === "blocked"} />,
      hint: STATUS_HINT,
    },
    {
      id: "dependency",
      label: "Blocked by",
      width: 116,
      sort: (row) =>
        row.dependency.kind === "blocked" ? 0 : row.dependency.kind === "met" ? 1 : 2,
      render: (row) => <DependencyCell dependency={row.dependency} />,
      hint: DEPENDENCY_HINT,
    },
  );

  if (!options.hideMilestone) {
    columns.push(
      {
        id: "milestone",
        label: "Milestone",
        width: 84,
        cellClass: "text-muted-foreground font-mono text-xs",
        sort: (row) => row.milestoneKey ?? "zzz",
        render: (row) => row.milestoneKey ?? <Absent label="none" />,
        hint: "The Milestone this Stream is assigned to. A Milestone is an assignment, not a parent — the Stream still belongs to its Epic.",
      },
      {
        id: "rank",
        label: "Rank",
        width: 72,
        align: "right",
        cellClass: "text-muted-foreground font-mono text-xs tabular-nums",
        sort: (row) => row.roadmapRank ?? Number.MAX_SAFE_INTEGER,
        render: (row) => (row.roadmapRank === null ? <Absent /> : row.roadmapRank),
        hint: RANK_HINT,
      },
    );
  }

  columns.push(
    colPriority<StreamRow>(),
    {
      id: "tasks",
      label: "Tasks",
      width: 80,
      align: "right",
      sort: (row) => (row.taskCount === 0 ? -1 : row.tasksDone / row.taskCount),
      render: (row) => fractionCell(row.tasksDone, row.taskCount),
      hint: "Tasks done over Tasks under this Stream. Zero of zero means the Stream has not been broken down yet.",
    },
    colRevision<StreamRow>(),
  );

  return columns;
}

/* ------------------------------------------------------------------ Tasks -- */

export function taskColumns(
  nav: EntityNav,
  options: { readonly hideStream?: boolean } = {},
): readonly Column<TaskRow>[] {
  const columns: Column<TaskRow>[] = [colKey<TaskRow>(nav), colTitle<TaskRow>()];

  if (!options.hideStream) {
    columns.push({
      id: "stream",
      label: "Stream",
      width: 64,
      sort: (row) => keySequence(row.streamKey),
      render: (row) => (
        <EntityKey
          entityKey={row.streamKey}
          className="text-muted-foreground"
          onClick={(event) => {
            event.stopPropagation();
            nav.inspect(row.streamKey);
          }}
        />
      ),
    });
  }

  columns.push(
    {
      id: "type",
      label: "Type",
      width: 104,
      cellClass: "text-muted-foreground text-xs",
      sort: (row) => row.taskType,
      render: (row) => row.taskType,
    },
    {
      id: "status",
      label: "Status",
      width: 124,
      sort: (row) => statusRank(row.status),
      render: (row) => (
        <StatusCell
          status={row.status}
          muted={row.dependency.kind === "blocked" || row.streamBlocked}
        />
      ),
      hint: STATUS_HINT,
    },
    {
      id: "dependency",
      label: "Blocked by",
      width: 128,
      sort: (row) =>
        row.dependency.kind === "blocked"
          ? 0
          : row.streamBlocked
            ? 1
            : row.dependency.kind === "met"
              ? 2
              : 3,
      render: (row) =>
        row.dependency.kind === "blocked" ? (
          <DependencyCell dependency={row.dependency} />
        ) : row.streamBlocked ? (
          // Named as inherited rather than reported as the Task's own blocker: the
          // prerequisite is on the Stream, and claiming it here would send a reader
          // looking for a Task-level edge that does not exist.
          <AbsentBox label="parent Stream" />
        ) : (
          <DependencyCell dependency={row.dependency} />
        ),
      hint: "A Task waits on its own Task-level prerequisites. `parent Stream` means the Task itself is clear but the Stream above it is held — both are read from the same stored graph.",
    },
    {
      id: "executor",
      label: "Executor",
      width: 116,
      sort: (row) => row.executor ?? "zzz",
      render: (row) => <ExecutorCell executor={row.executor} />,
      hint: "A stored preference for who may pick the Task up — never a live execution. Unspecified means the document carries no executor at all, which is not the same as either.",
    },
    colPriority<TaskRow>(),
    {
      id: "implements",
      label: "Implements",
      width: 100,
      align: "right",
      sort: (row) => row.targets.length,
      render: (row) => countCell(row.targets.length),
      hint: "How many typed business targets in the parent Stream this Task implements. The Task page resolves each one to the statement it points at, in that statement's own shape.",
    },
    {
      id: "scope",
      label: "Scope",
      width: 108,
      cellClass: "text-muted-foreground font-mono text-[11px]",
      sort: (row) => row.scope.join(","),
      render: (row) =>
        row.scope.length > 0 ? (
          <span title={row.scope.join(", ")}>{row.scope[0]}</span>
        ) : (
          <Absent label="none" />
        ),
      hint: "The technical surface this Task touches. Two Tasks sharing a scope is a possible collision, never a detected conflict — nothing here has been executed.",
    },
    {
      id: "verified",
      label: "Verified",
      width: 96,
      align: "right",
      cellClass: "font-mono text-xs tabular-nums",
      sort: (row) => row.verificationCount,
      render: (row) => `${String(row.verificationCount)} of ${String(row.doneWhenCount)}`,
      hint: "Verifications over done-when statements. Both are contained by the Task; neither is linked to an Acceptance criterion, because spec stores no such edge.",
    },
    colRevision<TaskRow>(),
  );

  return columns;
}
