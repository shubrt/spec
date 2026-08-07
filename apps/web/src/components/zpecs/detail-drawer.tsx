import { Link, useLoaderData, useNavigate, useSearch } from "@tanstack/react-router";
import { ExternalLinkIcon } from "lucide-react";
import { Button } from "~/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "~/components/ui/sheet";
import { ScrollArea } from "~/components/ui/scroll-area";
import { StreamDetail } from "~/components/zpecs/stream-detail";
import { TaskDetail } from "~/components/zpecs/task-detail";
import { EpicDetail } from "~/components/zpecs/epic-detail";
import { resolveDrawer, type DrawerTarget } from "~/lib/drawer";

/**
 * The detail drawer for an epic, stream and task.
 *
 * It is driven entirely by the root route's search parameters, so every detail
 * view is a URL: deep-linkable, bookmarkable, and closed by the browser's back
 * button rather than by a piece of component state that the URL knows nothing
 * about. Closing navigates instead of setting state, for the same reason.
 *
 * Nothing here refetches. The drawer keys stay out of `loaderDeps`, so opening a
 * drawer re-renders from the aggregate the loader already holds — which is what
 * makes a detail view free.
 */
export function DetailDrawer() {
  const board = useLoaderData({ from: "__root__" });
  const search = useSearch({ from: "__root__" });
  const navigate = useNavigate();

  const close = () => {
    // Drops every detail target and keeps `project`, so closing the drawer does
    // not also throw away which project is being looked at.
    void navigate({
      to: ".",
      search: (prev) => ({ project: prev.project, workspace: prev.workspace }),
    });
  };

  const aggregate = board.status === "ok" ? board.aggregate : null;
  const epics = aggregate?.epics ?? [];
  const target = resolveDrawer(epics, search);

  return (
    <Sheet open={target.kind !== "closed"} onOpenChange={(next) => (next ? undefined : close())}>
      <SheetContent
        side="right"
        className="flex w-[620px] max-w-[95vw] flex-col p-0"
        actions={
          aggregate &&
          (target.kind === "epic" || target.kind === "stream" || target.kind === "task") ? (
            <DrawerPageLink
              target={target}
              projectId={aggregate.project.id}
              workspace={search.workspace}
            />
          ) : undefined
        }
      >
        {target.kind === "stream" && aggregate ? (
          <ScrollArea className="flex-1">
            <StreamDetail
              stream={target.stream}
              surface="drawer"
              projectId={aggregate.project.id}
            />
          </ScrollArea>
        ) : null}

        {target.kind === "epic" && aggregate ? (
          <ScrollArea className="flex-1">
            <EpicDetail epic={target.epic} surface="drawer" projectId={aggregate.project.id} />
          </ScrollArea>
        ) : null}

        {target.kind === "task" && aggregate ? (
          <ScrollArea className="flex-1">
            <TaskDetail
              task={target.task}
              stream={target.stream}
              surface="drawer"
              projectId={aggregate.project.id}
            />
          </ScrollArea>
        ) : null}

        {target.kind === "missing" ? (
          <SheetHeader>
            <SheetTitle>Not in this project</SheetTitle>
            <SheetDescription>
              The link names an epic, stream or task that this project does not contain. It may have
              been removed, or it may belong to another project.
            </SheetDescription>
          </SheetHeader>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function DrawerPageLink({
  target,
  projectId,
  workspace,
}: {
  target: DrawerTarget;
  projectId: string;
  workspace: string | undefined;
}) {
  const search = { project: projectId, workspace };

  if (target.kind === "epic") {
    return (
      <Button asChild variant="ghost" size="icon" className="text-muted-foreground">
        <Link
          to="/epic/$epicKey"
          params={{ epicKey: target.epic.key }}
          search={search}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Open ${target.epic.key} in a new window`}
        >
          <ExternalLinkIcon aria-hidden="true" />
        </Link>
      </Button>
    );
  }

  if (target.kind === "stream") {
    return (
      <Button asChild variant="ghost" size="icon" className="text-muted-foreground">
        <Link
          to="/stream/$streamKey"
          params={{ streamKey: target.stream.key }}
          search={search}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Open ${target.stream.key} in a new window`}
        >
          <ExternalLinkIcon aria-hidden="true" />
        </Link>
      </Button>
    );
  }

  if (target.kind === "task") {
    return (
      <Button asChild variant="ghost" size="icon" className="text-muted-foreground">
        <Link
          to="/task/$taskKey"
          params={{ taskKey: target.task.key }}
          search={search}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Open ${target.task.key} in a new window`}
        >
          <ExternalLinkIcon aria-hidden="true" />
        </Link>
      </Button>
    );
  }

  return null;
}
