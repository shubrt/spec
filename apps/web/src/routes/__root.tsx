import { ClerkProvider, useClerk } from "@clerk/tanstack-react-start";
import { createRootRoute, HeadContent, Outlet, redirect, Scripts } from "@tanstack/react-router";
import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import { AppSidebar, ContextBar } from "~/components/spec/shell";
import { BoardStateProvider, useBoardState } from "~/lib/boardState";
import { validateRootSearch } from "~/lib/search";
import { fetchAuthState } from "~/server/auth";
import { getBoard } from "~/server/board";
import { getMcpEndpoint } from "~/server/connection";
import appCss from "../styles.css?url";

// The one route tree prefix that must stay reachable without a session,
// otherwise the guard below redirects the sign-in page to itself.
const SIGN_IN_PREFIX = "/sign-in";

const Inspector = lazy(() =>
  import("~/components/spec/inspector").then(({ Inspector: component }) => ({
    default: component,
  })),
);
const SearchOverlay = lazy(() =>
  import("~/components/spec/search-overlay").then(({ SearchOverlay: component }) => ({
    default: component,
  })),
);

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "spec · Operational Ledger" },
    ],
    links: [
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap",
      },
      { rel: "stylesheet", href: appCss },
    ],
  }),
  beforeLoad: async ({ location }) => {
    const { isAuthenticated, orgId, userId } = await fetchAuthState();

    if (!isAuthenticated && !location.pathname.startsWith(SIGN_IN_PREFIX)) {
      throw redirect({ to: "/sign-in/$", params: { _splat: "" } });
    }

    // Signed in with no active organization is deliberately NOT a redirect. The
    // identity is established; the workspace is what is missing, and the switcher
    // in the context bar is how the user fixes it. Sending them back to sign-in
    // would land them in the same session, forever. The API takes the same
    // position, answering that state with 403 no_workspace rather than 401.
    return { isAuthenticated, orgId, userId };
  },
  validateSearch: validateRootSearch,
  // `project` selects what is fetched. `workspace` is only a reload discriminator
  // changed by Clerk after an organization switch; tenant authority still comes
  // exclusively from the session token inside getBoard. `inspect` stays out, so
  // opening the Inspector does not refetch the aggregate.
  loaderDeps: ({ search }) => ({ project: search.project, workspace: search.workspace }),
  // The MCP endpoint is read from deployment configuration, not from the database,
  // so it costs nothing to fetch alongside the board — and three surfaces want it:
  // an empty Project, Settings · Integrations and Connection. Concurrent, so it
  // adds no latency to the one call that does touch Postgres.
  loader: async ({ deps }) => {
    const [board, mcp] = await Promise.all([getBoard({ data: deps.project }), getMcpEndpoint()]);
    return { board, mcp };
  },
  component: RootComponent,
});

function RootComponent() {
  const { isAuthenticated } = Route.useRouteContext();

  // Signed out, the only reachable route is the sign-in splat, which renders its
  // own surface — a sidebar with counts from a workspace you can no longer read
  // would be worse than no chrome at all.
  if (!isAuthenticated) {
    return (
      <RootDocument>
        <Outlet />
      </RootDocument>
    );
  }

  return (
    <RootDocument>
      <BoardStateProvider>
        <AppFrame />
      </BoardStateProvider>
    </RootDocument>
  );
}

/**
 * The frame: sidebar, context bar, the screen, and the two overlays.
 *
 * `relative` on the frame rather than on the page is what lets the Inspector and
 * the search dialog position against the work surface instead of the viewport, so
 * the sidebar stays reachable with a drawer open.
 */
function AppFrame() {
  const { signOut } = useClerk();
  const { orgId, userId } = Route.useRouteContext();
  const board = Route.useLoaderData();
  const { inspect } = Route.useSearch();
  const state = useBoardState();
  const [searchOpen, setSearchOpen] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && (event.key === "k" || event.key === "K")) {
        event.preventDefault();
        setSearchOpen(true);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const model = state.kind === "ready" ? state.model : null;
  const projects = board.board.status === "ok" ? board.board.projects : [];

  return (
    <div className="relative flex h-screen overflow-hidden">
      <AppSidebar model={model} actorId={userId} onSignOut={() => void signOut()} />
      <main className="flex min-w-0 flex-1 flex-col">
        <ContextBar
          orgId={orgId}
          projects={projects}
          currentProjectId={model?.projectId}
          currentProjectName={model?.projectName ?? "no Project"}
          onOpenSearch={() => setSearchOpen(true)}
        />
        <div className="min-h-0 flex-1 overflow-auto">
          <div className="px-6 pb-14 pt-6">
            <Outlet />
          </div>
        </div>
      </main>

      {/* Closed overlays stay out of the initial module graph and component tree. */}
      <Suspense fallback={null}>
        {model && inspect && !inspect.startsWith("rev:") ? <Inspector model={model} /> : null}
        {model && searchOpen ? (
          <SearchOverlay model={model} open onClose={() => setSearchOpen(false)} />
        ) : null}
      </Suspense>
    </div>
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
