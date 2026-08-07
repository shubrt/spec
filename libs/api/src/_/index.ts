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

// The executable host installs an evlog accessor through this side-effect-free bridge.
// Re-exporting it keeps evlog itself at the executable runtime boundary.
export { configureRequestEventLogger } from "./eventLog";

// Public URL, database and Clerk configuration remain owned by the shared API.
export { env } from "./env";
