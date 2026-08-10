import { z } from "zod";
import { VERSIONED_ENTITY_TYPE } from "../../enums";
import { referenceService } from "../../service/reference";
import {
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  type SearchContextResult,
  searchService,
} from "../../service/search";
import { defineTool } from "../defineTool";
import { TOOL_ERROR_CODE, structuredResult, toolError } from "../results";

/**
 * The scan tool: six short fields per hit, so a model can look at twenty of them
 * and then spend its context on the one it wants through `get_context`.
 *
 * `project` is resolved by **name** (an id is accepted too). A project row has no
 * key and no slug — only a `name`, unique per workspace — so the name is the one
 * identifier an agent can ever be told. An unknown project is refused rather than
 * ignored: silently searching the whole workspace after a typo would answer a
 * question nobody asked.
 */
const searchContextInput = z.strictObject({
  query: z.string().min(1).max(200),
  entity: z.enum(VERSIONED_ENTITY_TYPE).optional(),
  project: z.string().min(1).max(200).optional(),
  limit: z.number().int().min(1).max(MAX_SEARCH_LIMIT).default(DEFAULT_SEARCH_LIMIT),
});

/**
 * The compact hit shape, plus `matching`.
 *
 * `matching` is not decoration: when nothing contains the words the service falls
 * back to trigram similarity on titles, and a model that cannot tell the two apart
 * will act on a neighbouring stream believing it found the right one.
 */
const searchContextOutput = z.strictObject({
  hits: z.array(
    z.strictObject({
      project: z.string(),
      key: z.string(),
      title: z.string(),
      type: z.string(),
      status: z.string(),
      snippet: z.string(),
    }),
  ),
  matching: z.enum(["exact", "fuzzy"]),
});

const summarise = (result: SearchContextResult): string => {
  if (result.hits.length === 0) {
    return (
      "No Epic, Stream, Task, Milestone or Rule in this workspace matches that. Widen the words, or ask the " +
      "user whether this work exists yet — do not create anything on the strength of an " +
      "empty search."
    );
  }
  const header =
    result.matching === "fuzzy"
      ? `${String(result.hits.length)} approximate hit(s): no document contains those words, so these are the closest names. Confirm one is what you meant before acting on it.`
      : `${String(result.hits.length)} hit(s):`;
  const lines = result.hits.map(
    (hit) =>
      `${hit.key} [${hit.type}, ${hit.status}, project ${hit.project}] ${hit.title} — ${hit.snippet}`,
  );
  return [header, ...lines].join("\n");
};

export const searchContextTool = defineTool({
  name: "search_context",
  title: "Search context",
  annotations: { readOnlyHint: true },
  input: searchContextInput,
  output: searchContextOutput,
  run: async ({ input, scope }) => {
    let projectId: string | undefined;
    if (input.project !== undefined) {
      const resolved = await referenceService.resolveProject(scope, input.project);
      if (!resolved.ok) {
        return toolError(
          TOOL_ERROR_CODE.notFound,
          `No project of this workspace is called ${resolved.ref}. Call search_context without project to search all of them.`,
        );
      }
      projectId = resolved.project.id;
    }

    const result = await searchService.searchContext(scope, {
      query: input.query,
      entity: input.entity,
      projectId,
      limit: input.limit,
    });

    return structuredResult(summarise(result), {
      hits: result.hits,
      matching: result.matching,
    });
  },
});
