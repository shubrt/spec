/**
 * The root route's search parameters: which Project is open, and what the
 * Inspector is showing.
 *
 * The Inspector is driven by the URL rather than by component state, because a
 * detail view that is open is a URL you can paste to a colleague, and the back
 * button closes it. Per-screen filters live on their own routes for the same
 * reason — an empty filtered result is then shareable and reproducible instead of
 * being a state only you can see.
 *
 * Entities are addressed by their **public key** and not by their uuid. A key is
 * project-scoped, stable, never reused, and it is the identifier every screen
 * already shows; a uuid in the address bar is a value nobody can check against
 * what is on the page.
 */
export interface RootSearch {
  /** Which Project's aggregate the root loader fetches. */
  project?: string;
  /**
   * A reload discriminator written after Clerk changes the active organization.
   * Never trusted as tenant authority — the API derives scope from the session
   * token's `org_id`.
   */
  workspace?: string;
  /** The Inspector target. At most one is meaningful; `inspect` names which. */
  inspect?: string;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Applied on the root route, so `?project=` and `?inspect=` are available and
 * type-safe on every child route.
 *
 * Anything that is not a non-empty string becomes `undefined` rather than
 * throwing — these values come from a URL a human can edit, and a malformed one
 * should show the default view, not an error page.
 */
export function validateRootSearch(search: Record<string, unknown>): RootSearch {
  return {
    project: asString(search.project),
    workspace: asString(search.workspace),
    inspect: asString(search.inspect),
  };
}

/**
 * What survives a navigation: which Project you are looking at, and nothing else.
 *
 * An open Inspector does not follow you to another screen. It was opened over a
 * particular table to answer a question about a row in it; carrying it along would
 * leave a drawer floating over a screen that never asked for it.
 */
export function carry(previous: RootSearch): RootSearch {
  return { project: previous.project, workspace: previous.workspace };
}

/**
 * Clerk navigates here only after it has made the organization active. Including
 * the id changes the root loader dependency even when the user is already on `/`,
 * so the next read cannot keep the previous tenant's aggregate in memory. The id
 * is a cache-buster, not an authorization input.
 */
export function workspaceChangedUrl(clerkOrgId: string): string {
  return `/?workspace=${encodeURIComponent(clerkOrgId)}`;
}

/**
 * The complete search state for opening a Project.
 *
 * Only the Clerk reload discriminator survives: an Inspector target belongs to the
 * Project being left, and its key would resolve to a different entity — or to
 * nothing — in the next one, because keys are minted per Project.
 */
export function projectChangedSearch(
  previous: Pick<RootSearch, "workspace">,
  projectId: string,
): RootSearch {
  return { project: projectId, workspace: previous.workspace };
}

/**
 * Resolves `?project=` against the workspace's projects, falling back to the
 * first of the list.
 *
 * An unknown or stale id resolves to the default rather than an empty screen: the
 * value comes from a URL, so it can name a project that was archived or that
 * belongs to a workspace the user has since switched away from, and neither
 * deserves an error state. The list arrives ordered by name, so "first" is stable
 * rather than arbitrary.
 */
export function selectProject<T extends { id: string }>(
  projects: readonly T[],
  requestedId: string | undefined,
): T | null {
  const requested = requestedId
    ? projects.find((project) => project.id === requestedId)
    : undefined;
  return requested ?? projects[0] ?? null;
}
