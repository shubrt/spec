import { useLoaderData, useNavigate, useSearch } from "@tanstack/react-router";
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
import { resolveDrawer } from "~/lib/drawer";

/**
 * The detail drawer for a stream and a task.
 *
 * It is driven entirely by the root route's search parameters, so every detail
 * view is a URL: deep-linkable, bookmarkable, and closed by the browser's back
 * button rather than by a piece of component state that the URL knows nothing
 * about. Closing navigates instead of setting state, for the same reason.
 *
 * Nothing here refetches. `loaderDeps` is keyed on `project` alone, so opening a
 * drawer re-renders from the aggregate the loader already holds — which is what
 * makes a detail view free.
 */
export function DetailDrawer() {
  const board = useLoaderData({ from: "__root__" });
  const search = useSearch({ from: "__root__" });
  const navigate = useNavigate();

  const close = () => {
    // Drops `stream` and `task` and keeps `project`, so closing the drawer does
    // not also throw away which project is being looked at.
    void navigate({ to: ".", search: (prev) => ({ project: prev.project }) });
  };

  const epics = board.status === "ok" ? (board.aggregate?.epics ?? []) : [];
  const target = resolveDrawer(epics, search);

  return (
    <Sheet open={target.kind !== "closed"} onOpenChange={(next) => (next ? undefined : close())}>
      <SheetContent side="right" className="flex w-[620px] max-w-[95vw] flex-col p-0">
        {target.kind === "stream" ? (
          <ScrollArea className="flex-1">
            <StreamDetail stream={target.stream} />
          </ScrollArea>
        ) : null}

        {target.kind === "task" ? (
          <ScrollArea className="flex-1">
            <TaskDetail task={target.task} stream={target.stream} />
          </ScrollArea>
        ) : null}

        {target.kind === "missing" ? (
          <SheetHeader>
            <SheetTitle>Not in this project</SheetTitle>
            <SheetDescription>
              The link names a stream or task that this project does not contain. It may have been
              removed, or it may belong to another project.
            </SheetDescription>
          </SheetHeader>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
