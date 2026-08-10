import { z } from "zod";
import { VERSIONED_ENTITY_TYPE } from "../../enums";
import {
  DEFAULT_LIST_CONTEXT_LIMIT,
  MAX_LIST_CONTEXT_LIMIT,
  type ListContextPage,
  listContextService,
} from "../../service/listContext";
import { defineTool } from "../defineTool";
import { TOOL_ERROR_CODE, keyLookupError, structuredResult, toolError } from "../results";

/**
 * Cheap structural discovery: project names, or compact rows from one or more
 * project trees. Full documents belong to `get_context` and never cross this
 * boundary.
 */
const listContextInput = z.strictObject({
  project: z.string().min(1).max(200).optional(),
  entity: z.enum(VERSIONED_ENTITY_TYPE).optional(),
  status: z.string().trim().min(1).max(32).optional(),
  parent: z.string().min(1).max(64).optional(),
  milestone: z.string().min(1).max(64).optional(),
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.number().int().min(1).max(MAX_LIST_CONTEXT_LIMIT).default(DEFAULT_LIST_CONTEXT_LIMIT),
});

const listContextRowOutput = z.strictObject({
  project: z.string(),
  key: z.string(),
  title: z.string(),
  entity: z.enum(VERSIONED_ENTITY_TYPE),
  subtype: z.string().nullable(),
  status: z.string(),
  revision: z.number().int().positive(),
  parent_key: z.string().nullable(),
  roadmap: z
    .strictObject({
      milestone_key: z.string(),
      milestone_order: z.number().int(),
      stream_rank: z.number().int().nullable(),
    })
    .optional(),
});

const listContextOutput = z.strictObject({
  mode: z.enum(["projects", "entities"]),
  projects: z.array(z.strictObject({ name: z.string() })),
  rows: z.array(listContextRowOutput),
  next_cursor: z.string().nullable(),
});

const indent = { epic: "", stream: "  ", task: "    ", milestone: "", rule: "" } as const;

const renderProjects = (page: Extract<ListContextPage, { mode: "projects" }>): string => {
  if (page.projects.length === 0) {
    return "No projects exist in this workspace.";
  }
  return [
    `${String(page.projects.length)} project(s):`,
    ...page.projects.map((project) => `- ${project.name}`),
    ...(page.nextCursor === null
      ? []
      : [`More projects exist. Call list_context again with cursor: ${page.nextCursor}`]),
  ].join("\n");
};

const renderEntities = (page: Extract<ListContextPage, { mode: "entities" }>): string => {
  if (page.rows.length === 0) {
    return "No entities match this list scope and its filters.";
  }
  const lines: string[] = [];
  let currentProject: string | null = null;
  for (const row of page.rows) {
    if (row.project !== currentProject) {
      currentProject = row.project;
      lines.push(`${row.project}:`);
    }
    const type = row.subtype === null ? row.entity : `${row.entity}:${row.subtype}`;
    const parent = row.parentKey === null ? "" : ` · parent ${row.parentKey}`;
    const roadmap =
      row.entity === "milestone"
        ? ` · roadmap order ${String(row.roadmapOrder ?? "unknown")}`
        : row.entity === "stream" && row.milestoneKey !== null
          ? ` · milestone ${row.milestoneKey} (order ${String(row.roadmapOrder ?? "unknown")}) · roadmap rank ${String(row.roadmapRank ?? "unranked")}`
          : "";
    lines.push(
      `${indent[row.entity]}- ${row.key} [${type}, ${row.status}, rev ${String(row.revision)}] ${row.title}${parent}${roadmap}`,
    );
  }
  return [
    `${String(page.rows.length)} compact entity row(s):`,
    ...lines,
    ...(page.nextCursor === null
      ? []
      : [`More rows exist. Repeat the same filters with cursor: ${page.nextCursor}`]),
    "Load one key with get_context when its full document is needed.",
  ].join("\n");
};

const structuredPage = (page: ListContextPage) => ({
  mode: page.mode,
  projects: page.projects,
  rows: page.rows.map((row) => {
    const roadmap =
      row.entity === "milestone" && row.roadmapOrder !== null
        ? {
            milestone_key: row.key,
            milestone_order: row.roadmapOrder,
            stream_rank: null,
          }
        : row.milestoneKey !== null && row.roadmapOrder !== null
          ? {
              milestone_key: row.milestoneKey,
              milestone_order: row.roadmapOrder,
              stream_rank: row.roadmapRank,
            }
          : undefined;
    return {
      project: row.project,
      key: row.key,
      title: row.title,
      entity: row.entity,
      subtype: row.subtype,
      status: row.status,
      revision: row.revision,
      parent_key: row.parentKey,
      ...(roadmap === undefined ? {} : { roadmap }),
    };
  }),
  next_cursor: page.nextCursor,
});

export const listContextTool = defineTool({
  name: "list_context",
  title: "List context",
  annotations: { readOnlyHint: true },
  input: listContextInput,
  output: listContextOutput,
  run: async ({ input, scope }) => {
    const result = await listContextService.listContext(scope, input);
    if (!result.ok) {
      if (result.reason === "invalid_cursor") {
        return toolError(TOOL_ERROR_CODE.invalidArguments, result.message);
      }
      if (result.reason === "invalid_parent_kind") {
        return toolError(
          TOOL_ERROR_CODE.invalidArguments,
          `${result.key} is a ${result.entity} key. parent accepts only an Epic or Stream key because Milestones are a roadmap overlay and Tasks have no hierarchy children.`,
        );
      }
      if (result.reason === "invalid_milestone_kind") {
        return toolError(
          TOOL_ERROR_CODE.invalidArguments,
          `${result.key} is a ${result.entity} key. milestone accepts only a Milestone key such as M-2.`,
        );
      }
      return keyLookupError(result);
    }
    return structuredResult(
      result.mode === "projects" ? renderProjects(result) : renderEntities(result),
      structuredPage(result),
    );
  },
});
