import { auth, clerkClient } from "@clerk/tanstack-react-start/server";
import { createServerFn } from "@tanstack/react-start";

/**
 * The session state the root route's guard and loader branch on.
 *
 * `orgId` is the active Clerk organization, which in spec *is* the workspace:
 * the session token carries `org_id`, and the API derives the tenant scope from
 * it. A session with no active organization is a legitimate, renderable state,
 * not a failure — hence a nullable field rather than an error.
 */
export interface AuthState {
  readonly isAuthenticated: boolean;
  readonly orgId: string | null;
  /**
   * The Clerk user id — the one identity spec ever writes down, as the actor on a
   * revision. Resolved here rather than from Clerk's client hook so it is server
   * rendered: that hook is null during SSR, which made every surface showing it
   * paint a dash first and swap in the real id on hydration.
   */
  readonly userId: string | null;
  /** Primary email of the user, for display only. Null when Clerk has none or the lookup failed. */
  readonly userEmail: string | null;
  /** Display name of the active organization. Null under the same conditions. */
  readonly orgName: string | null;
}

// Root beforeLoad runs on every navigation, so the Clerk Backend API lookups behind
// the display labels are memoized per process. A rename shows up within the TTL.
const LABEL_TTL_MS = 60_000;
const labels = new Map<string, { readonly value: string | null; readonly expires: number }>();

async function cachedLabel(key: string, load: () => Promise<string | null>) {
  const hit = labels.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  // A failed lookup degrades to the raw id in the UI rather than failing the route.
  const value = await load().catch(() => null);
  labels.set(key, { value, expires: Date.now() + LABEL_TTL_MS });
  return value;
}

// `auth()` is server-only and reads the auth object clerkMiddleware put on the
// start context, so it cannot be called from beforeLoad directly — beforeLoad
// also runs in the browser. This server function is that boundary.
export const fetchAuthState = createServerFn({ method: "GET" }).handler(
  async (): Promise<AuthState> => {
    const { userId, orgId } = await auth();
    const [userEmail, orgName] = await Promise.all([
      userId
        ? cachedLabel(`user:${userId}`, async () => {
            const user = await clerkClient().users.getUser(userId);
            return user.primaryEmailAddress?.emailAddress ?? null;
          })
        : null,
      orgId
        ? cachedLabel(`org:${orgId}`, async () => {
            const org = await clerkClient().organizations.getOrganization({
              organizationId: orgId,
            });
            return org.name;
          })
        : null,
    ]);
    // Both halves are reported separately because they fail differently: no
    // `userId` means sign in, while a `userId` with no `orgId` means the session
    // has no workspace — a state the UI has to render as an action ("create or
    // join an organization"), not as an error.
    return {
      isAuthenticated: userId !== null,
      orgId: orgId ?? null,
      userId: userId ?? null,
      userEmail,
      orgName,
    };
  },
);
