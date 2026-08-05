/**
 * Every view-selecting piece of state this app has, carried in the URL.
 *
 * `project` chooses which aggregate the root loader fetches. `workspace` is a
 * reload discriminator written after Clerk changes the active organization; it
 * is never trusted as tenant authority (the API uses the session token's
 * `org_id`). `epic`, `stream` and `task` each open the detail drawer on that
 * entity, which is why they are search parameters rather than component state:
 * a drawer that is open is a URL you can paste to a colleague, and the back
 * button closes it.
 */
export interface DrawerSearch {
  project?: string;
  workspace?: string;
  epic?: string;
  stream?: string;
  task?: string;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Search params are hierarchical: applying this on the root route makes
 * `?project=` / `?epic=` / `?stream=` / `?task=` available, and type-safe, on
 * every child route.
 *
 * Anything that is not a non-empty string becomes `undefined` rather than
 * throwing — these values come from a URL a human can edit, and a malformed one
 * should show the default view, not an error page.
 */
export function validateDrawerSearch(search: Record<string, unknown>): DrawerSearch {
  return {
    project: asString(search.project),
    workspace: asString(search.workspace),
    epic: asString(search.epic),
    stream: asString(search.stream),
    task: asString(search.task),
  };
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
 * The complete search state for opening a project.
 *
 * Both the picker and a successful create use this projection. Only the Clerk
 * workspace reload discriminator survives: detail ids belong to the project
 * being left and must not open a stale drawer in the next one.
 */
export function projectChangedSearch(
  previous: Pick<DrawerSearch, "workspace">,
  projectId: string,
): Pick<DrawerSearch, "project" | "workspace"> {
  return { project: projectId, workspace: previous.workspace };
}

/**
 * Resolves `?project=` against the workspace's projects, falling back to the
 * first of the list.
 *
 * An unknown or stale id resolves to the default rather than an empty screen:
 * the value comes from a URL, so it can name a project that was archived or
 * that belongs to a workspace the user has since switched away from, and
 * neither deserves an error state. The list arrives ordered by name, so "first"
 * is stable rather than arbitrary.
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
