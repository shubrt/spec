import { createFileRoute, Link, useLoaderData } from "@tanstack/react-router";
import { Card } from "~/components/ui/card";
import { Progress } from "~/components/ui/progress";
import { BoardFailure, EmptyWorkspace } from "~/components/zpecs/board-failure";
import { Toolbar } from "~/components/zpecs/toolbar";
import { EntityKey, StatusBadge, StatusDot, TypeTag } from "~/components/zpecs/tokens";
import { asArray, asText, contentOf, type MilestoneExitCriterion } from "~/lib/document";
import { allStreams } from "~/lib/summary";
import { label, milestoneStatus, streamStatus } from "~/lib/vocabulary";
import type { MilestoneNode, StreamNode } from "~/server/board";

export const Route = createFileRoute("/roadmap")({
  component: RoadmapPage,
});

function RoadmapPage() {
  const board = useLoaderData({ from: "__root__" });

  if (board.status !== "ok") return <BoardFailure failure={board} />;
  if (!board.aggregate) return <EmptyWorkspace workspaceName={board.workspace.name} />;

  const { milestones, epics, project } = board.aggregate;
  const assignedKeys = new Set(
    milestones.flatMap((milestone) => milestone.streams.map((stream) => stream.key)),
  );
  const backlog = allStreams(epics).filter((stream) => !assignedKeys.has(stream.key));

  return (
    <>
      <Toolbar title="Roadmap">
        <span className="text-sm text-muted-foreground">Advisory sequence · no delivery dates</span>
        <div className="flex-1" />
        <span className="text-sm tabular-nums text-muted-foreground">
          {milestones.length} {milestones.length === 1 ? "Milestone" : "Milestones"}
        </span>
      </Toolbar>

      <div className="flex flex-col gap-6 px-8 pb-16 pt-6">
        {milestones.length === 0 ? (
          <Card className="p-8 text-center text-sm text-muted-foreground">
            No Milestones have been defined. Streams remain available in their Epics.
          </Card>
        ) : (
          <div className="flex flex-col gap-4">
            {milestones.map((milestone) => (
              <MilestoneCard key={milestone.id} milestone={milestone} projectId={project.id} />
            ))}
          </div>
        )}

        <Backlog streams={backlog} projectId={project.id} />
      </div>
    </>
  );
}

function MilestoneCard({ milestone, projectId }: { milestone: MilestoneNode; projectId: string }) {
  const content = contentOf(milestone.document);
  const criteria = asArray<MilestoneExitCriterion>(content.exit_criteria);
  const fulfilled = criteria.filter(
    (criterion) => criterion.status === "met" || criterion.status === "waived",
  ).length;
  const completion = criteria.length === 0 ? 0 : Math.round((fulfilled / criteria.length) * 100);

  return (
    <Card className="overflow-hidden">
      <Link
        to="/milestone/$milestoneKey"
        params={{ milestoneKey: milestone.key }}
        search={(previous) => ({ project: projectId, workspace: previous.workspace })}
        className="block border-b p-4 transition-colors hover:bg-secondary/40"
      >
        <div className="flex flex-wrap items-center gap-2.5">
          <span className="font-mono text-[11px] text-muted-foreground">
            order {milestone.roadmapOrder}
          </span>
          <EntityKey>{milestone.key}</EntityKey>
          <span className="flex-1 font-bold tracking-tight">{milestone.title}</span>
          <StatusBadge tone={milestoneStatus.toneOf(milestone.status)}>
            {label(milestone.status)}
          </StatusBadge>
        </div>
        {asText(content.goal) || milestone.summary ? (
          <p className="mt-2 text-sm leading-relaxed text-secondary-foreground">
            {asText(content.goal) || milestone.summary}
          </p>
        ) : null}
        <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          <span>
            {milestone.streams.length} assigned{" "}
            {milestone.streams.length === 1 ? "Stream" : "Streams"}
          </span>
          {criteria.length > 0 ? (
            <>
              <Progress value={completion} className="w-24" />
              <span className="tabular-nums">
                {fulfilled}/{criteria.length} exit criteria
              </span>
            </>
          ) : (
            <span>No exit criteria yet</span>
          )}
        </div>
      </Link>

      {milestone.streams.length > 0 ? (
        <ul>
          {milestone.streams.map((stream) => (
            <li key={stream.id} className="border-t first:border-t-0">
              <Link
                to="/stream/$streamKey"
                params={{ streamKey: stream.key }}
                search={(previous) => ({ project: projectId, workspace: previous.workspace })}
                className="flex flex-wrap items-center gap-3 px-4 py-2.5 transition-colors hover:bg-secondary/50"
              >
                <StatusDot tone={streamStatus.toneOf(stream.status)} />
                <EntityKey>{stream.key}</EntityKey>
                <span className="flex-1 text-[13px] font-medium">{stream.title}</span>
                <TypeTag>{label(stream.streamType)}</TypeTag>
                <span className="text-xs text-muted-foreground">Epic {stream.epicKey}</span>
                {stream.roadmapRank === null ? null : (
                  <span className="text-xs tabular-nums text-muted-foreground">
                    rank {stream.roadmapRank}
                  </span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}

function Backlog({ streams, projectId }: { streams: readonly StreamNode[]; projectId: string }) {
  if (streams.length === 0) return null;
  return (
    <section>
      <div className="mb-3 flex items-baseline gap-2">
        <h2 className="text-sm font-bold tracking-tight">Unscheduled Streams</h2>
        <span className="text-xs tabular-nums text-muted-foreground">{streams.length}</span>
      </div>
      <Card className="overflow-hidden">
        <p className="border-b px-4 py-3 text-xs text-muted-foreground">
          Not being in a Milestone does not block work; hard prerequisites are modeled separately.
        </p>
        <ul>
          {streams.map((stream) => (
            <li key={stream.id} className="border-t first:border-t-0">
              <Link
                to="/stream/$streamKey"
                params={{ streamKey: stream.key }}
                search={(previous) => ({ project: projectId, workspace: previous.workspace })}
                className="flex flex-wrap items-center gap-3 px-4 py-2.5 transition-colors hover:bg-secondary/50"
              >
                <StatusDot tone={streamStatus.toneOf(stream.status)} />
                <EntityKey>{stream.key}</EntityKey>
                <span className="flex-1 text-[13px] font-medium">{stream.title}</span>
                <TypeTag>{label(stream.streamType)}</TypeTag>
              </Link>
            </li>
          ))}
        </ul>
      </Card>
    </section>
  );
}
