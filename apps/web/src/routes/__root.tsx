import { ClerkProvider } from "@clerk/tanstack-react-start";
import { createRootRoute, HeadContent, Outlet, redirect, Scripts } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { WorkspaceSwitcher } from "~/components/zpecs/workspace-switcher";
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

  return (
    <RootDocument>
      {isAuthenticated ? (
        <header className="flex h-14 flex-none items-center justify-end border-b px-4">
          <WorkspaceSwitcher />
        </header>
      ) : null}
      <Outlet />
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
