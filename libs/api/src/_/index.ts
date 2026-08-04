import Elysia from "elysia";
import { mcpRoute } from "../api/mcp/route";

export const app = new Elysia().use(mcpRoute);

export type App = typeof app;
