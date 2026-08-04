import type { ZpecsTool } from "./defineTool";
import { applyChangeSetTool } from "./tools/applyChangeSet";
import { getContextTool } from "./tools/getContext";
import { getEntitySchemaTool } from "./tools/getEntitySchema";
import { getNextWorkTool } from "./tools/getNextWork";
import { searchContextTool } from "./tools/searchContext";
import { validateChangeSetTool } from "./tools/validateChangeSet";

/**
 * The one list of tools zpecs exposes.
 *
 * `createMcpServer` iterates exactly this array and nothing else registers a
 * tool, which is what makes `defineTool`'s checks unskippable: a new tool has to
 * be added here to exist at all, and it can only be built by the factory.
 *
 * Order is the order a client sees in `tools/list`, so it reads as the intended
 * workflow — find, load, learn the shape, dry-run, apply — with `get_next_work`
 * last as the separate "what now" entry point.
 *
 * Only `search_context` declares an `outputSchema`; the plan's tool table
 * specifies `structuredContent` for that tool alone, and the remaining five get
 * their result shapes with their bodies in workstream B.
 */
export const zpecsTools: readonly ZpecsTool[] = [
  searchContextTool,
  getContextTool,
  getEntitySchemaTool,
  validateChangeSetTool,
  applyChangeSetTool,
  getNextWorkTool,
];
