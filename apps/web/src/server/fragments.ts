import { auth } from "@clerk/tanstack-react-start/server";
import { createServerFn } from "@tanstack/react-start";
import { selectProject } from "~/lib/search";
import { createApiClient } from "./api";

/**
 * Specification fragments, paged by the server.
 *
 * A fragment is not a row — it lives inside a document as jsonb — so the browser used
 * to hold every document in the project in order to page a list of them. The API
 * extracts and pages them now; what arrives is the rows on screen plus the counts a
 * filter control needs.
 */

export interface FragmentQuery {
  readonly projectId?: string;
  readonly offset?: number;
  readonly limit?: number;
  readonly section?: string;
  /** One entity's fragments — how a detail page loads its own document sections. */
  readonly owner?: string;
  readonly q?: string;
}

const EMPTY = {
  fragments: [],
  total: 0,
  offset: 0,
  limit: 20,
  sectionCounts: [],
  ownerCount: 0,
} as const;

export const getFragments = createServerFn({ method: "GET" })
  .validator((query: FragmentQuery) => query)
  .handler(async ({ data }) => {
    const { getToken } = await auth();
    const sessionToken = await getToken();
    if (!sessionToken) return EMPTY;

    const api = createApiClient(sessionToken);
    try {
      let projectId = data.projectId;
      if (!projectId) {
        const projectsResponse = await api.workspace.projects.get();
        if (projectsResponse.error) return EMPTY;
        projectId = selectProject(projectsResponse.data.projects, undefined)?.id;
      }
      if (!projectId) return EMPTY;

      const response = await api.workspace.projects({ projectId }).fragments.get({
        query: {
          offset: data.offset ?? 0,
          limit: data.limit ?? 20,
          section: data.section,
          owner: data.owner,
          q: data.q,
        },
      });
      return response.error ? EMPTY : response.data;
    } catch {
      return EMPTY;
    }
  });

export type FragmentPage = Awaited<ReturnType<typeof getFragments>>;
export type FragmentEntry = FragmentPage["fragments"][number];
