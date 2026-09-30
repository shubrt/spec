import type { SpecTool } from "./defineTool";
import { applyChangeSetTool } from "./tools/applyChangeSet";
import { getContextTool } from "./tools/getContext";
import { getEntitySchemaTool } from "./tools/getEntitySchema";
import { getNextWorkTool } from "./tools/getNextWork";
import { listContextTool } from "./tools/listContext";
import { searchContextTool } from "./tools/searchContext";
import { validateChangeSetTool } from "./tools/validateChangeSet";

/**
 * The one list of tools spec exposes.
 *
 * `createMcpServer` iterates exactly this array and nothing else registers a
 * tool, which is what makes `defineTool`'s checks unskippable: a new tool has to
 * be added here to exist at all, and it can only be built by the factory.
 *
 * Order is the order a client sees in `tools/list`, so it reads as the intended
 * workflow — list or search, load, learn the shape, dry-run, apply — with
 * `get_next_work` last as the separate "what now" entry point.
 *
 * Discovery and context tools declare shallow output schemas. Their compact
 * shapes belong in `tools/list`; full entity-document schemas remain on demand
 * through `get_entity_schema`.
 */
export const specTools: readonly SpecTool[] = [
  listContextTool,
  searchContextTool,
  getContextTool,
  getEntitySchemaTool,
  validateChangeSetTool,
  applyChangeSetTool,
  getNextWorkTool,
];
