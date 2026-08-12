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
      const projectsResponse = await api.workspace.projects.get();
      if (projectsResponse.error) return EMPTY;
      const selected = selectProject(projectsResponse.data.projects, data.projectId);
      if (!selected) return EMPTY;

      const response = await api.workspace
        .projects({ projectId: selected.id })
        .search.get({ query: { q: data.q, limit: data.limit ?? 60 } });
      return response.error ? EMPTY : response.data;
    } catch {
      return EMPTY;
    }
  });

export type SearchResult = Awaited<ReturnType<typeof searchProject>>;
export type SearchHit = SearchResult["hits"][number];
