import { auth } from "@clerk/tanstack-react-start/server";
import { createServerFn } from "@tanstack/react-start";

/**
 * The session state the root route's guard and loader branch on.
 *
 * `orgId` is the active Clerk organization, which in zpecs *is* the workspace:
 * the session token carries `org_id`, and the API derives the tenant scope from
 * it. A session with no active organization is a legitimate, renderable state,
 * not a failure — hence a nullable field rather than an error.
 */
export interface AuthState {
  readonly isAuthenticated: boolean;
  readonly orgId: string | null;
  /**
   * The Clerk user id — the one identity zpecs ever writes down, as the actor on a
   * revision. Resolved here rather than from Clerk's client hook so it is server
   * rendered: that hook is null during SSR, which made every surface showing it
   * paint a dash first and swap in the real id on hydration.
   */
  readonly userId: string | null;
}

// `auth()` is server-only and reads the auth object clerkMiddleware put on the
// start context, so it cannot be called from beforeLoad directly — beforeLoad
// also runs in the browser. This server function is that boundary.
export const fetchAuthState = createServerFn({ method: "GET" }).handler(
  async (): Promise<AuthState> => {
    const { userId, orgId } = await auth();
    // Both halves are reported separately because they fail differently: no
    // `userId` means sign in, while a `userId` with no `orgId` means the session
    // has no workspace — a state the UI has to render as an action ("create or
    // join an organization"), not as an error.
    return { isAuthenticated: userId !== null, orgId: orgId ?? null, userId: userId ?? null };
  },
);
