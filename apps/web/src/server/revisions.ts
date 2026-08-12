import { auth } from "@clerk/tanstack-react-start/server";
import { createServerFn } from "@tanstack/react-start";
import { selectProject } from "~/lib/search";
import { createApiClient } from "./api";

/**
 * The revision log for one Project.
 *
 * A second server function rather than a field on the board aggregate, because the
 * cost profile is different: the aggregate is read on every navigation, the history
 * by the one screen that shows it. Only `/changes` asks for this.
 *
 * The API has already diffed each revision against its predecessor, so what arrives
 * here is derived metadata and not several hundred document snapshots.
 *
 * It takes the same optional `?project=` the board takes and resolves it the same
 * way — through {@link selectProject}, falling back to the first project — because
 * a caller that had to resolve it first would need the project list, which is a
 * round trip this function is already making.
 */

const EMPTY = { revisions: [] } as const;

export const getRevisions = createServerFn({ method: "GET" })
  .validator((projectId?: string) => projectId)
  .handler(async ({ data: projectId }) => {
    const { getToken } = await auth();
    const sessionToken = await getToken();
    // The root loader already reports a missing session as a failure state and
    // this screen renders inside that, so an empty log is the right answer here
    // rather than a second copy of the same message.
    if (!sessionToken) return EMPTY;

    const api = createApiClient(sessionToken);

    try {
      const projectsResponse = await api.workspace.projects.get();
      if (projectsResponse.error) return EMPTY;

      const selected = selectProject(projectsResponse.data.projects, projectId);
      if (!selected) return EMPTY;

      const response = await api.workspace.projects({ projectId: selected.id }).revisions.get();
      return response.error ? EMPTY : response.data;
    } catch {
      return EMPTY;
    }
  });

/** The `revisions` array, projected off the API's own response type. */
export type RevisionLog = Awaited<ReturnType<typeof getRevisions>>["revisions"];
