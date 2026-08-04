import Elysia from "elysia";
import { mcpRoute } from "../api/mcp/route";

export const app = new Elysia().use(mcpRoute);

export type App = typeof app;

// Re-exported so the launcher (apps/web) can read PORT without its own
// env schema — libs/api is "all code", apps/web is just the launcher.
export { env } from "./env";
