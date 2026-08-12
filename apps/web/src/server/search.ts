import { auth } from "@clerk/tanstack-react-start/server";
import { createServerFn } from "@tanstack/react-start";
import { selectProject } from "~/lib/search";
import { createApiClient } from "./api";

/**
 * Project search.
 *
 * Ranked server-side, and every hit carries the rule it matched on — which is what
 * makes the ordering checkable rather than merely plausible. Fragment hits carry
 * their anchor, because a local key like `AC-2` identifies nothing on its own.
 */

export interface SearchQuery {
  readonly projectId?: string;
  readonly q: string;
  readonly limit?: number;
}

const EMPTY = { hits: [], total: 0, cap: 60, indexed: 0 } as const;

export const searchProject = createServerFn({ method: "GET" })
  .validator((query: SearchQuery) => query)
  .handler(async ({ data }) => {
    if (data.q.trim().length === 0) return EMPTY;

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

      const response = await api.workspace
        .projects({ projectId })
        .search.get({ query: { q: data.q, limit: data.limit ?? 60 } });
      return response.error ? EMPTY : response.data;
    } catch {
      return EMPTY;
    }
  });

export type SearchResult = Awaited<ReturnType<typeof searchProject>>;
export type SearchHit = SearchResult["hits"][number];
