import { auth } from "@clerk/tanstack-react-start/server";
import { createServerFn } from "@tanstack/react-start";
import { toApiFailure, type ApiFailure } from "~/lib/apiFailure";
import type { Jsonified } from "~/lib/document";
import { selectProject } from "~/lib/search";
import { createApiClient } from "./api";

/**
 * The single read-only aggregate the whole UI derives from, fetched once per
 * project through in-process Eden Treaty calls.
 *
 * Filtering and sorting are the client's job over this one payload: the MVP
 * deliberately does not paginate or server-filter, so no interaction needs
 * another server-function request.
 *
 * Failures are values, not exceptions. A root loader that throws blanks the
 * entire app, and two of the three failure modes here — no session, no
 * workspace — are ordinary states a user can be in and act on.
 */

const UNREACHABLE = {
  status: "unavailable",
  message: "The zpecs API could not complete the request.",
  apiReachable: false,
} satisfies ApiFailure;

/**
 * Invokes one embedded API operation and turns an unexpected throw into `null`.
 *
 * Treaty returns HTTP errors in `error` rather than throwing, so this `try` is
 * not about status codes — it covers failures while invoking the embedded API,
 * including database connectivity. Only the call itself sits inside it: a
 * throw from the mapping code below would be a bug in this file, and reporting
 * that as "the API could not complete the request" would send someone hunting
 * in the wrong package.
 */
async function reachable<T>(call: () => Promise<T>): Promise<T | null> {
  try {
    return await call();
  } catch {
    return null;
  }
}

export const getBoard = createServerFn({ method: "GET" })
  .validator((projectId?: string) => projectId)
  .handler(async ({ data: projectId }) => {
    const { getToken } = await auth();
    const sessionToken = await getToken();

    if (!sessionToken) {
      return {
        status: "signed_out",
        message: "Sign in to see this workspace.",
        apiReachable: false,
      } satisfies ApiFailure;
    }

    const api = createApiClient(sessionToken);

    const head = await reachable(() =>
      Promise.all([api.workspace.get(), api.workspace.projects.get()]),
    );
    if (!head) return UNREACHABLE;
    const [workspaceResponse, projectsResponse] = head;

    if (workspaceResponse.error) return toApiFailure(workspaceResponse.error);
    if (projectsResponse.error) return toApiFailure(projectsResponse.error);

    const { projects } = projectsResponse.data;
    const selected = selectProject(projects, projectId);

    // A workspace with no project is a legitimate state, not a failure: nothing
    // has been created through MCP yet, so there is no aggregate to ask for.
    if (!selected) {
      return {
        status: "ok" as const,
        workspace: workspaceResponse.data,
        projects,
        aggregate: null,
      };
    }

    // The aggregate cannot join the two calls above, because *which* project to
    // fetch is the answer `selectProject` gives — `?project=` may be absent, or
    // may name a project this workspace no longer has. This requires a second
    // invocation phase on load, but none afterwards.
    const aggregateResponse = await reachable(() =>
      api.workspace.projects({ projectId: selected.id }).get(),
    );
    if (!aggregateResponse) return UNREACHABLE;
    if (aggregateResponse.error) return toApiFailure(aggregateResponse.error);

    return {
      status: "ok" as const,
      workspace: workspaceResponse.data,
      projects,
      // The only cast in this file, and it removes an `unknown` rather than
      // inventing a shape. Every entity's `document` is typed
      // `Record<string, unknown>` by the API — deliberately, so a document
      // written before a schema change stays readable — and TanStack Start
      // refuses to return `unknown` from a server function because it cannot
      // know the value survives serialisation. This one did: it came out of
      // `JSON.parse`. `Jsonified` says exactly that and nothing more, and being
      // mechanical it keeps every other field bound to the API's own type.
      aggregate: aggregateResponse.data as Jsonified<typeof aggregateResponse.data>,
    };
  });

/**
 * What the root route's loader resolves to. Narrow on `status`: `"ok"` carries
 * the data, the other three are {@link ApiFailure} and carry a message.
 */
export type Board = Awaited<ReturnType<typeof getBoard>>;

/** The `"ok"` branch of {@link Board}, for code that has already narrowed. */
export type LoadedBoard = Extract<Board, { status: "ok" }>;

/**
 * The project tree and its three levels, named so components can take them as
 * props.
 *
 * These are projections of the API's own response type rather than
 * hand-written interfaces, so a field the server renames or drops becomes a
 * type error in the components that read it instead of an `undefined` on screen.
 */
export type Aggregate = NonNullable<LoadedBoard["aggregate"]>;
export type EpicNode = Aggregate["epics"][number];
export type StreamNode = EpicNode["streams"][number];
export type TaskNode = StreamNode["tasks"][number];
