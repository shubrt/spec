import { auth } from "@clerk/tanstack-react-start/server";
import { createServerFn } from "@tanstack/react-start";
import type { JsonObject } from "~/lib/document";
import type { FragmentEntry } from "./fragments";
import { selectProject } from "~/lib/search";
import { createApiClient } from "./api";

/**
 * One entity's document, whole.
 *
 * The board aggregate carries a pruned copy of every document, because it is
 * fetched on every navigation and most of what a Task holds is rendered by nothing
 * — measured on the live workspace, the Task documents were 266 KB of which the
 * screens read 37. This is the other half of that trade: a page that is already
 * about one entity asks for that entity when it needs a section the aggregate drops.
 */

/** One immutable observation the fragments of this entity cite by id. */
export interface SourceEntry {
  readonly id: string;
  readonly type: string;
  readonly reference: string;
  readonly snapshot: string | null;
  readonly supersedes: readonly string[];
  /** Freshness is superseding-based: this is the whole of it. Age is never a signal. */
  readonly supersededBy: readonly string[];
}

export interface EntityQuery {
  readonly projectId?: string;
  readonly key: string;
}

export type EntityDocumentResult =
  | {
      readonly ok: true;
      readonly document: JsonObject;
      readonly fragments: readonly FragmentEntry[];
      readonly sources: readonly SourceEntry[];
      /** For a Task: the parent Stream's fragments, so its targets can be quoted. */
      readonly targetFragments: readonly FragmentEntry[];
    }
  | { readonly ok: false };

const MISSING = { ok: false } as const satisfies EntityDocumentResult;

export const getEntityDocument = createServerFn({ method: "GET" })
  .validator((query: EntityQuery) => query)
  .handler(async ({ data }): Promise<EntityDocumentResult> => {
    const { getToken } = await auth();
    const sessionToken = await getToken();
    if (!sessionToken) return MISSING;

    const api = createApiClient(sessionToken);

    try {
      let projectId = data.projectId;
      if (!projectId) {
        const projectsResponse = await api.workspace.projects.get();
        if (projectsResponse.error) return MISSING;
        projectId = selectProject(projectsResponse.data.projects, undefined)?.id;
      }
      if (!projectId) return MISSING;

      const response = await api.workspace
        .projects({ projectId })
        .entities({ key: data.key })
        .get();
      // A key from a URL can name something this Project does not hold, which is an
      // ordinary outcome rather than an error: the page renders without the section.
      // The one cast here, and it removes an `unknown` rather than inventing a
      // shape: the API types every document `Record<string, unknown>` on purpose,
      // and TanStack Start refuses to return `unknown` from a server function
      // because it cannot know the value survives serialisation. This one did — it
      // came out of `JSON.parse`.
      return response.error
        ? MISSING
        : {
            ok: true,
            document: response.data.document as JsonObject,
            fragments: response.data.fragments,
            sources: response.data.sources,
            targetFragments: response.data.targetFragments,
          };
    } catch {
      return MISSING;
    }
  });
