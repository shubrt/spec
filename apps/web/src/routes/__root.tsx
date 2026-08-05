import { ClerkProvider } from "@clerk/tanstack-react-start";
import { createRootRoute, HeadContent, Outlet, redirect, Scripts } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { AppHeader } from "~/components/zpecs/app-header";
import { DetailDrawer } from "~/components/zpecs/detail-drawer";
import { validateDrawerSearch } from "~/lib/search";
import { fetchAuthState } from "~/server/auth";
import { getBoard } from "~/server/board";
import appCss from "../styles.css?url";

// The one route tree prefix that must stay reachable without a session,
// otherwise the guard below redirects the sign-in page to itself.
const SIGN_IN_PREFIX = "/sign-in";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "zpecs · Project Management" },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  beforeLoad: async ({ location }) => {
    const { isAuthenticated, orgId } = await fetchAuthState();

    if (!isAuthenticated && !location.pathname.startsWith(SIGN_IN_PREFIX)) {
      throw redirect({ to: "/sign-in/$", params: { _splat: "" } });
    }

    // Signed in with no active organization is deliberately NOT a redirect. The
    // identity is established; the workspace is what is missing, and the switcher
    // in the header is how the user fixes it. Sending them back to sign-in would
    // land them in the same session, forever. The API takes the same position,
    // answering that state with 403 no_workspace rather than 401.
    return { isAuthenticated, orgId };
  },
  validateSearch: validateDrawerSearch,
  // Only `project` selects what is fetched. The drawer parameters deliberately
  // stay out of the deps so opening or closing a detail view re-renders from the
  // aggregate already in memory instead of refetching it.
  loaderDeps: ({ search }) => ({ project: search.project }),
  loader: ({ deps }) => getBoard({ data: deps.project }),
  component: RootComponent,
});

function RootComponent() {
  const { isAuthenticated } = Route.useRouteContext();

  // Signed out, the only reachable route is the sign-in splat, which renders on
  // its own — chrome and a drawer would both be furniture around a login box.
  if (!isAuthenticated) {
    return (
      <RootDocument>
        <Outlet />
      </RootDocument>
    );
  }

  return (
    <RootDocument>
      <div className="flex h-screen flex-col overflow-hidden">
        <AppHeader />
        <main className="flex flex-1 flex-col overflow-auto">
          <Outlet />
        </main>
      </div>
      {/* The drawer lives at the root, not in a page, because `?stream=` and
          `?task=` are root search parameters: a detail view stays open across a
          navigation between the overview and the epic list. */}
      <DetailDrawer />
    </RootDocument>
  );
}

function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <ClerkProvider>
      <html lang="en">
        <head>
          <HeadContent />
        </head>
        <body>
          {children}
          <Scripts />
        </body>
      </html>
    </ClerkProvider>
  );
}
