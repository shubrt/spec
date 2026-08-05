import { Link } from "@tanstack/react-router";
import { Card } from "~/components/ui/card";
import { Progress } from "~/components/ui/progress";
import { EntityKey, StatusBadge, StatusDot, TypeTag } from "~/components/zpecs/tokens";
import { asText, contentOf } from "~/lib/document";
import { taskCompletion } from "~/lib/summary";
import { epicStatus, label, streamStatus } from "~/lib/vocabulary";
import type { EpicNode, StreamNode } from "~/server/board";

/**
 * The epic list: every epic, with the streams that belong to it nested beneath.
 *
 * The nesting is the point of the page. An epic is a standing business
 * capability and a stream is a bounded change to it, so a flat list of either
 * one loses the relationship that makes the board readable.
 *
 * Epic and stream rows open the detail drawer through the URL, which is why they
 * are links rather than buttons: a detail view is something you can middle-click,
 * bookmark and send to someone.
 */

export function EpicList({ epics }: { epics: readonly EpicNode[] }) {
  if (epics.length === 0) {
    return (
      <div className="p-16 text-center text-sm text-muted-foreground">
        No epics match these filters.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {epics.map((epic) => (
        <EpicCard key={epic.id} epic={epic} />
      ))}
    </div>
  );
}

function EpicCard({ epic }: { epic: EpicNode }) {
  const purpose = epic.summary ?? asText(contentOf(epic.document).purpose);
  const tasks = epic.streams.flatMap((stream) => stream.tasks);
  const completion = taskCompletion(tasks);

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 border-b p-4">
        <Link
          to="."
          search={(prev) => ({
            project: prev.project,
            workspace: prev.workspace,
            epic: epic.id,
          })}
          className="contents"
        >
          <EntityKey>{epic.key}</EntityKey>
          <span className="text-base font-bold tracking-tight hover:underline">{epic.title}</span>
        </Link>
        <StatusBadge tone={epicStatus.toneOf(epic.status)}>{label(epic.status)}</StatusBadge>
        <div className="flex-1" />
        <span className="text-xs tabular-nums text-muted-foreground">
          {epic.streams.length} {epic.streams.length === 1 ? "stream" : "streams"}
          {completion.total > 0 ? ` · ${completion.done}/${completion.total} tasks` : null}
        </span>
      </div>

      {purpose ? (
        <p className="border-b px-4 py-3 text-sm leading-relaxed text-secondary-foreground">
          {purpose}
        </p>
      ) : null}

      {epic.streams.length === 0 ? (
        <p className="px-4 py-3 text-sm text-muted-foreground">
          No streams in this epic{" "}
          <span className="text-xs">— nothing has been scoped under it yet.</span>
        </p>
      ) : (
        <ul>
          {epic.streams.map((stream) => (
            <StreamRow key={stream.id} stream={stream} />
          ))}
        </ul>
      )}
    </Card>
  );
}

function StreamRow({ stream }: { stream: StreamNode }) {
  const completion = taskCompletion(stream.tasks);

  return (
    <li className="border-t first:border-t-0">
      <Link
        to="."
        search={(prev) => ({
          project: prev.project,
          workspace: prev.workspace,
          stream: stream.id,
        })}
        className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 transition-colors hover:bg-secondary/50"
      >
        <StatusDot tone={streamStatus.toneOf(stream.status)} />
        <EntityKey>{stream.key}</EntityKey>
        <span className="flex-1 text-[13px] font-medium">{stream.title}</span>
        <TypeTag>{label(stream.streamType)}</TypeTag>
        <StatusBadge tone={streamStatus.toneOf(stream.status)}>{label(stream.status)}</StatusBadge>
        {completion.total > 0 ? (
          <span className="flex w-28 items-center gap-2">
            <Progress value={completion.pct} className="flex-1" />
            <span className="text-[11px] tabular-nums text-muted-foreground">
              {completion.done}/{completion.total}
            </span>
          </span>
        ) : (
          <span className="w-28 text-right text-[11px] text-muted-foreground">no tasks</span>
        )}
      </Link>
    </li>
  );
}
