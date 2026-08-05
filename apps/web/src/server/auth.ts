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
}

// `auth()` is server-only and reads the auth object clerkMiddleware put on the
// start context, so it cannot be called from beforeLoad directly — beforeLoad
// also runs in the browser. This server function is that boundary.
export const fetchAuthState = createServerFn({ method: "GET" }).handler(
  async (): Promise<AuthState> => {
    const { isAuthenticated, orgId } = await auth();
    return { isAuthenticated, orgId: orgId ?? null };
  },
);
