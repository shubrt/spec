import Elysia from "elysia";
import { mcpRoute } from "../api/mcp/route";
import { wellKnownRoutes } from "../api/mcp/wellKnown";

export const app = new Elysia().use(mcpRoute).use(wellKnownRoutes);

export type App = typeof app;

// Re-exported so the launcher (apps/web) can read PORT without its own
// env schema — libs/api is "all code", apps/web is just the launcher.
export { env } from "./env";
