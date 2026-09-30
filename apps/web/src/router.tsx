import { createRouter } from "@tanstack/react-router";
import { NotFound } from "~/components/spec/not-found";
import { routeTree } from "./routeTree.gen";

// TanStack Start calls getRouter() to build a fresh router instance per request.
export function getRouter() {
  return createRouter({
    routeTree,
    scrollRestoration: true,
    defaultPreload: "intent",
    defaultNotFoundComponent: NotFound,
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
