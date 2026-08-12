import { auth } from "@clerk/tanstack-react-start/server";
import { createServerFn } from "@tanstack/react-start";
import { selectProject } from "~/lib/search";
import { createApiClient } from "./api";

/**
 * One page of the revision log.
 *
 * A separate server function rather than a field on the board aggregate, because
 * the cost profile is different: the aggregate is read on every navigation, the
 * history by the one screen that shows it — and that history is the only list in
 * the product that grows without bound.
 *
 * Filtering and paging happen on the server, so the page carries the rows on screen
 * rather than the whole log. The API has already diffed each revision against its
 * predecessor, so what arrives is derived metadata and not several hundred document
 * snapshots.
 */

const ENTITY_TYPES = ["epic", "stream", "task", "milestone", "rule"] as const;
const CHANGE_KINDS = ["created", "status", "structure", "text"] as const;

/**
 * The two enum-valued filters arrive from a URL a human can edit, so they are
 * narrowed here rather than cast. An unrecognised value drops the filter instead of
 * reaching the API as a 422 — a mistyped query parameter should show the unfiltered
 * list, not an error page.
 */
const asEntityType = (value: string | undefined) =>
  ENTITY_TYPES.find((candidate) => candidate === value);
const asKind = (value: string | undefined) => CHANGE_KINDS.find((candidate) => candidate === value);

export interface RevisionQuery {
  readonly projectId?: string;
  readonly offset?: number;
  readonly limit?: number;
  readonly from?: string;
  readonly to?: string;
  readonly entityType?: string;
  readonly kind?: string;
  readonly actor?: string;
  readonly entityKey?: string;
}

const EMPTY = {
  revisions: [],
  total: 0,
  offset: 0,
  limit: 25,
  actors: [],
  reasonCount: 0,
  earliest: null,
  latest: null,
} as const;

export const getRevisions = createServerFn({ method: "GET" })
  .validator((query: RevisionQuery) => query)
  .handler(async ({ data }) => {
    const { getToken } = await auth();
    const sessionToken = await getToken();
    // The root loader already reports a missing session as a failure state and
    // this screen renders inside that, so an empty page is the right answer here
    // rather than a second copy of the same message.
    if (!sessionToken) return EMPTY;

    const api = createApiClient(sessionToken);

    try {
      let projectId = data.projectId;
      if (!projectId) {
        const projectsResponse = await api.workspace.projects.get();
        if (projectsResponse.error) return EMPTY;
        // Resolved the same way the board resolves it, so `?project=` being absent
        // means the same project on both screens.
        projectId = selectProject(projectsResponse.data.projects, undefined)?.id;
      }
      if (!projectId) return EMPTY;

      const response = await api.workspace.projects({ projectId }).revisions.get({
        query: {
          offset: data.offset ?? 0,
          limit: data.limit ?? 25,
          from: data.from,
          to: data.to,
          entityType: asEntityType(data.entityType),
          kind: asKind(data.kind),
          actor: data.actor,
          entityKey: data.entityKey,
        },
      });
      return response.error ? EMPTY : response.data;
    } catch {
      return EMPTY;
    }
  });

/** One page, projected off the API's own response type. */
export type RevisionPage = Awaited<ReturnType<typeof getRevisions>>;
export type RevisionLog = RevisionPage["revisions"];
