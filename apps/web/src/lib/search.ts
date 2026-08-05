/**
 * Every view-selecting piece of state this app has, carried in the URL.
 *
 * `project` chooses which aggregate the root loader fetches. `epic`, `stream`
 * and `task` each open the detail drawer on that entity, which is why they are
 * search parameters rather than component state: a drawer that is open is a URL
 * you can paste to a colleague, and the back button closes it.
 */
export interface DrawerSearch {
  project?: string;
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
    epic: asString(search.epic),
    stream: asString(search.stream),
    task: asString(search.task),
  };
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
