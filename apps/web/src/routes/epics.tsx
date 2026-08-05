import { createFileRoute, useLoaderData } from "@tanstack/react-router";
import { useState } from "react";
import { Input } from "~/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { BoardFailure, EmptyWorkspace } from "~/components/zpecs/board-failure";
import { EpicList } from "~/components/zpecs/epic-list";
import { Toolbar } from "~/components/zpecs/toolbar";
import {
  ANY_STATUS,
  filterEpics,
  type EpicSort,
  type EpicStatusFilter,
  type StreamStatusFilter,
} from "~/lib/epicFilter";
import { epicStatus, label, streamStatus } from "~/lib/vocabulary";

/**
 * The epic list, with each epic's streams nested beneath it.
 *
 * Every control on this page filters and sorts the aggregate the root loader
 * already holds. None of them refetches: the MVP deliberately does not paginate
 * or server-filter, so typing in the search box costs nothing but a re-render.
 * The organization-switch discriminator is the only non-project loader
 * dependency, so a Clerk workspace change deliberately does refetch.
 */
export const Route = createFileRoute("/epics")({
  component: EpicsPage,
});

function EpicsPage() {
  const board = useLoaderData({ from: "__root__" });
  const [query, setQuery] = useState("");
  const [epicFilter, setEpicFilter] = useState<EpicStatusFilter>(ANY_STATUS);
  const [streamFilter, setStreamFilter] = useState<StreamStatusFilter>(ANY_STATUS);
  const [sort, setSort] = useState<EpicSort>("default");

  if (board.status !== "ok") return <BoardFailure failure={board} />;
  if (!board.aggregate) return <EmptyWorkspace workspaceName={board.workspace.name} />;

  const { epics } = board.aggregate;
  const shown = filterEpics(epics, {
    query,
    epicStatus: epicFilter,
    streamStatus: streamFilter,
    sort,
  });

  return (
    <>
      <Toolbar title="Epics">
        <Input
          placeholder="Search epics and streams…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="w-64"
        />

        <Select
          value={epicFilter}
          onValueChange={(value) => setEpicFilter(value as EpicStatusFilter)}
        >
          <SelectTrigger className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY_STATUS}>All epics</SelectItem>
            {/* Driven by the vocabulary, so a status the API gains appears here
                without anyone remembering to add it. */}
            {epicStatus.values.map((status) => (
              <SelectItem key={status} value={status}>
                {label(status)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={streamFilter}
          onValueChange={(value) => setStreamFilter(value as StreamStatusFilter)}
        >
          <SelectTrigger className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY_STATUS}>All streams</SelectItem>
            {streamStatus.values.map((status) => (
              <SelectItem key={status} value={status}>
                {label(status)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={sort} onValueChange={(value) => setSort(value as EpicSort)}>
          <SelectTrigger className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="default">Sort: created</SelectItem>
            <SelectItem value="title">Sort: title</SelectItem>
          </SelectContent>
        </Select>

        <div className="flex-1" />
        <span className="text-sm tabular-nums text-muted-foreground">
          {shown.length} of {epics.length}
        </span>
      </Toolbar>

      <div className="px-8 pb-16 pt-6">
        <EpicList epics={shown} />
      </div>
    </>
  );
}
