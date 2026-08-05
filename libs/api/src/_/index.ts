import Elysia from "elysia";
import { projectHandler } from "../api/handler/project";
import { workspaceHandler } from "../api/handler/workspace";
import { mcpRoute } from "../api/mcp/route";
import { wellKnownRoutes } from "../api/mcp/wellKnown";

export const app = new Elysia()
  .use(mcpRoute)
  .use(wellKnownRoutes)
  .use(workspaceHandler)
  .use(projectHandler);

export type App = typeof app;

// Re-exported so the launcher (apps/web) can read PORT without its own
// env schema — libs/api is "all code", apps/web is just the launcher.
export { env } from "./env";
