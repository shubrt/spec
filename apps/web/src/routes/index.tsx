import { createFileRoute, Link, useLoaderData } from "@tanstack/react-router";
import { Card } from "~/components/ui/card";
import { Progress } from "~/components/ui/progress";
import { BoardFailure, EmptyWorkspace } from "~/components/zpecs/board-failure";
import { StatusDot } from "~/components/zpecs/tokens";
import { Toolbar } from "~/components/zpecs/toolbar";
import {
  allStreams,
  allTasks,
  countByStatus,
  taskCompletion,
  type StatusCount,
} from "~/lib/summary";
import { epicStatus, formatDate, streamStatus, taskStatus } from "~/lib/vocabulary";

/**
 * The project overview: how much work exists, and what state it is in.
 *
 * Every number here is derived from the one aggregate the root loader already
 * holds. The API exposes no counts, and asking it for any would be a second round
 * trip for something the payload answers — the project row's three counters are
 * the change-set engine's bookkeeping and deliberately not on the wire.
 */
export const Route = createFileRoute("/")({
  component: OverviewPage,
});

function OverviewPage() {
  const board = useLoaderData({ from: "__root__" });

  if (board.status !== "ok") return <BoardFailure failure={board} />;
  if (!board.aggregate) return <EmptyWorkspace workspaceName={board.workspace.name} />;

  const { project, epics } = board.aggregate;
  const streams = allStreams(epics);
  const tasks = allTasks(epics);
  const completion = taskCompletion(tasks);

  return (
    <>
      <Toolbar title={project.name}>
        <span className="text-sm text-muted-foreground">{board.workspace.name}</span>
        <div className="flex-1" />
        <span className="text-xs text-muted-foreground">
          Updated {formatDate(project.updatedAt)} · created {formatDate(project.createdAt)}
        </span>
      </Toolbar>

      <div className="flex flex-col gap-6 px-8 pb-16 pt-6">
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <Figure caption="Epics" value={epics.length} />
          <Figure caption="Streams" value={streams.length} />
          <Figure caption="Tasks" value={tasks.length} />
          <Card className="p-4">
            <Caption>Tasks done</Caption>
            <div className="mt-1 text-2xl font-bold tabular-nums tracking-tight">
              {completion.pct}%
            </div>
            <div className="mt-2 flex items-center gap-2">
              <Progress value={completion.pct} className="flex-1" />
              <span className="text-[11px] tabular-nums text-muted-foreground">
                {completion.done}/{completion.total}
              </span>
            </div>
          </Card>
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <Breakdown title="Epics by status" rows={countByStatus(epics, epicStatus)} />
          <Breakdown title="Streams by status" rows={countByStatus(streams, streamStatus)} />
          <Breakdown title="Tasks by status" rows={countByStatus(tasks, taskStatus)} />
        </div>

        {epics.length > 0 ? (
          <Link
            to="/epics"
            search={(prev) => ({ project: prev.project, workspace: prev.workspace })}
            className="text-sm font-medium text-primary hover:underline"
          >
            Browse all {epics.length} {epics.length === 1 ? "epic" : "epics"} and their streams →
          </Link>
        ) : (
          <p className="text-sm text-muted-foreground">
            This project has no epics yet. Every entity in zpecs is written through the MCP server,
            so ask your agent to plan one.
          </p>
        )}
      </div>
    </>
  );
}

function Caption({ children }: { children: string }) {
  return (
    <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
      {children}
    </div>
  );
}

function Figure({ caption, value }: { caption: string; value: number }) {
  return (
    <Card className="p-4">
      <Caption>{caption}</Caption>
      <div className="mt-1 text-2xl font-bold tabular-nums tracking-tight">{value}</div>
    </Card>
  );
}

/**
 * One vocabulary's full breakdown.
 *
 * Every status is listed, including those with a count of zero: "nothing is
 * blocked" is exactly the fact a reader wants confirmed, and a breakdown built
 * from only the statuses present would leave them guessing. Zero rows are dimmed
 * rather than dropped.
 */
function Breakdown({ title, rows }: { title: string; rows: readonly StatusCount[] }) {
  return (
    <Card className="p-4">
      <div className="mb-3">
        <Caption>{title}</Caption>
      </div>
      <ul>
        {rows.map((row) => (
          <li
            key={row.status}
            className="flex items-center gap-2.5 border-t py-1.5 text-[13px] first:border-t-0"
          >
            <StatusDot tone={row.tone} />
            <span className={row.count === 0 ? "flex-1 text-muted-foreground" : "flex-1"}>
              {row.label}
            </span>
            <span
              className={
                row.count === 0
                  ? "tabular-nums text-muted-foreground"
                  : "font-semibold tabular-nums"
              }
            >
              {row.count}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
