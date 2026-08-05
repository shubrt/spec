import { auth } from "@clerk/tanstack-react-start/server";
import { createServerFn } from "@tanstack/react-start";
import { toApiFailure, type ApiFailure } from "~/lib/apiFailure";
import { selectProject } from "~/lib/search";
import { createApiClient } from "./api";

/**
 * The single read-only aggregate the whole UI derives from, fetched once per
 * project through Eden Treaty from the server.
 *
 * Filtering and sorting are the client's job over this one payload: the MVP
 * deliberately does not paginate or server-filter, so no interaction costs a
 * second round trip.
 *
 * Failures are values, not exceptions. A root loader that throws blanks the
 * entire app, and two of the three failure modes here — no session, no
 * workspace — are ordinary states a user can be in and act on.
 */
export const getBoard = createServerFn({ method: "GET" })
  .validator((projectId?: string) => projectId)
  .handler(async ({ data: projectId }) => {
    const { getToken } = await auth();
    const sessionToken = await getToken();

    if (!sessionToken) {
      return {
        status: "signed_out",
        message: "Sign in to see this workspace.",
      } satisfies ApiFailure;
    }

    const api = createApiClient(sessionToken);

    // Treaty returns HTTP errors in `error` rather than throwing, but a refused
    // connection is not an HTTP error at all — and @zpecs/api simply not running
    // is the most common state during local development.
    let workspaceResponse: Awaited<ReturnType<typeof api.workspace.get>>;
    let projectsResponse: Awaited<ReturnType<typeof api.workspace.projects.get>>;
    try {
      [workspaceResponse, projectsResponse] = await Promise.all([
        api.workspace.get(),
        api.workspace.projects.get(),
      ]);
    } catch {
      return {
        status: "unavailable",
        message: "The zpecs API is not reachable.",
      } satisfies ApiFailure;
    }

    if (workspaceResponse.error) return toApiFailure(workspaceResponse.error);
    if (projectsResponse.error) return toApiFailure(projectsResponse.error);

    const { projects } = projectsResponse.data;

    return {
      status: "ok" as const,
      workspace: workspaceResponse.data,
      projects,
      project: selectProject(projects, projectId),
    };
  });

/**
 * What the root route's loader resolves to. Narrow on `status`: `"ok"` carries
 * the data, the other three are {@link ApiFailure} and carry a message.
 */
export type Board = Awaited<ReturnType<typeof getBoard>>;
