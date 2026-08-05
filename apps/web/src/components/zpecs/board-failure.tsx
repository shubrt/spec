import { Link } from "@tanstack/react-router";
import { Button } from "~/components/ui/button";
import { CreateProjectDialog } from "~/components/zpecs/create-project-dialog";
import type { ApiFailure } from "~/lib/apiFailure";

/**
 * The three states in which there is no board to draw.
 *
 * Each gets its own remedy, because they are genuinely different situations and
 * only one of them is a fault. `no_workspace` in particular is a perfectly valid
 * signed-in session that simply has no active organization — the API answers it
 * `403` rather than `401` for exactly that reason — so it must not be dressed up
 * as an error. The remedy is the organization switcher in the header.
 */

const REMEDY: Record<ApiFailure["status"], string> = {
  signed_out: "Sign in to continue.",
  no_workspace: "Create or join an organization from the switcher in the header, then reload.",
  unavailable: "Nothing is lost — this page only reads. Try again in a moment.",
};

export function BoardFailure({ failure }: { failure: ApiFailure }) {
  return (
    <div className="flex flex-1 items-center justify-center p-16">
      <div className="max-w-md text-center">
        <h1 className="mb-2 text-base font-bold tracking-tight">
          {failure.status === "no_workspace" ? "No workspace selected" : "Nothing to show"}
        </h1>
        {/* The message is the API's own, so what the user reads is what the
            server actually said rather than this app's guess at it. */}
        <p className="mb-1 text-sm text-secondary-foreground">{failure.message}</p>
        <p className="text-sm text-muted-foreground">{REMEDY[failure.status]}</p>
        {failure.status === "signed_out" ? (
          <Link
            to="/sign-in/$"
            params={{ _splat: "" }}
            className="mt-4 inline-flex items-center rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground"
          >
            Sign in
          </Link>
        ) : null}
      </div>
    </div>
  );
}

/**
 * A project-less workspace, which is not a failure at all. Any member can create
 * its first empty project here; entity content still enters through MCP.
 * Kept next to {@link BoardFailure} because it occupies the same page slot.
 */
export function EmptyWorkspace({ workspaceName }: { workspaceName: string }) {
  return (
    <div className="flex flex-1 items-center justify-center p-16">
      <div className="max-w-md text-center">
        <h1 className="mb-2 text-base font-bold tracking-tight">No projects yet</h1>
        <p className="text-sm text-secondary-foreground">
          {workspaceName} has no projects. Create one to start with an empty project.
        </p>
        <CreateProjectDialog
          workspaceName={workspaceName}
          trigger={<Button className="mt-5">Create project</Button>}
        />
      </div>
    </div>
  );
}
