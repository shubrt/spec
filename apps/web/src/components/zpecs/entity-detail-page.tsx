import { Link, useLoaderData, useSearch } from "@tanstack/react-router";
import { Button } from "~/components/ui/button";
import { BoardFailure, EmptyWorkspace } from "~/components/zpecs/board-failure";
import { EpicDetail } from "~/components/zpecs/epic-detail";
import { StreamDetail } from "~/components/zpecs/stream-detail";
import { TaskDetail } from "~/components/zpecs/task-detail";
import { resolveEntityDetail, type EntityDetailReference } from "~/lib/entityDetail";

/**
 * The shared shell for the three standalone entity routes.
 *
 * It deliberately consumes the root loader rather than defining a route loader:
 * every detail page is another projection of the project aggregate already in
 * memory, just like the drawer. `?project=` is checked against the aggregate
 * before resolving a key because the server intentionally falls an unknown
 * project id back to the workspace's default project.
 */
export function EntityDetailPage({ entity }: { entity: EntityDetailReference }) {
  const board = useLoaderData({ from: "__root__" });
  const search = useSearch({ from: "__root__" });

  if (board.status !== "ok") return <BoardFailure failure={board} />;
  if (!board.aggregate) return <EmptyWorkspace workspaceName={board.workspace.name} />;

  const { aggregate } = board;
  const requestedDifferentProject =
    search.project !== undefined && search.project !== aggregate.project.id;
  const target = requestedDifferentProject
    ? { kind: "missing" as const }
    : resolveEntityDetail(aggregate.epics, entity);

  if (target.kind === "missing") {
    return <MissingEntity projectId={aggregate.project.id} workspace={search.workspace} />;
  }

  return (
    <article className="mx-auto w-full max-w-3xl bg-card sm:my-6 sm:rounded-xl sm:border">
      {target.kind === "epic" ? (
        <EpicDetail epic={target.epic} surface="page" projectId={aggregate.project.id} />
      ) : null}

      {target.kind === "stream" ? (
        <StreamDetail stream={target.stream} surface="page" projectId={aggregate.project.id} />
      ) : null}

      {target.kind === "task" ? (
        <TaskDetail
          task={target.task}
          stream={target.stream}
          surface="page"
          projectId={aggregate.project.id}
        />
      ) : null}
    </article>
  );
}

function MissingEntity({ projectId, workspace }: { projectId: string; workspace?: string }) {
  return (
    <div className="flex flex-1 items-center justify-center p-8 sm:p-16">
      <div className="max-w-md text-center">
        <h1 className="mb-2 text-base font-bold tracking-tight">Not in this project</h1>
        <p className="text-sm text-secondary-foreground">
          The link names an epic, stream or task that this project does not contain. It may have
          been removed, or it may belong to another project.
        </p>
        <Button asChild variant="outline" className="mt-5">
          <Link to="/epics" search={{ project: projectId, workspace }}>
            Back to epics
          </Link>
        </Button>
      </div>
    </div>
  );
}
