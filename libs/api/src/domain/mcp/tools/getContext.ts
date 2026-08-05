import { z } from "zod";
import { type BundleSubject, type ContextBundle, buildContextBundle } from "../../context/bundle";
import { type EntityReference, referenceService } from "../../service/reference";
import { defineTool } from "../defineTool";
import { keyLookupError, structuredResult } from "../results";

/**
 * One entity by key, plus the domain spec §7 bundle — the parent stream's purpose,
 * the requirements the entity references, the acceptance criteria that verify them,
 * the business rules and edge cases that apply, and the dependencies.
 *
 * `project` is the key qualifier. Keys are unique per project, so a bare key is
 * resolved by asking every project in the workspace and two answers is a refusal;
 * without this argument a two-project workspace could not address `EPIC-1` at all.
 */
const getContextInput = z.strictObject({
  key: z
    .string()
    .min(1)
    .max(64)
    .describe("Entity key as returned by search_context, for example TASK-123."),
  project: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe("Which project the key is in, by name. Needed only if two projects share a key."),
  include_bundle: z
    .boolean()
    .default(true)
    // The bundle's contents are listed once, in this tool's description. Repeating
    // them here paid for the same sentence twice in every `tools/list`.
    .describe("Set false only when the raw document is all that is wanted."),
});

/**
 * Deliberately shallow.
 *
 * `document` and `bundle` are declared as objects and not spelled out, because the
 * document's real shape is 8–10 KB of generated JSON Schema per entity type. That
 * belongs in `get_entity_schema` and `zpecs://schema/{entity}`, served on demand, not
 * in a `tools/list` payload that is re-sent every turn under a 12 KB budget. The
 * fields below are the ones a caller needs *without* knowing the entity type —
 * above all `revision`, which every subsequent write has to send back.
 */
const getContextOutput = z.strictObject({
  entity: z.string(),
  key: z.string(),
  title: z.string(),
  status: z.string(),
  // The only two output fields carrying a description: both say something a
  // caller cannot infer from the field name, and both are load-bearing — the
  // revision is what the next write must send back, and the project name is the
  // qualifier for the next key lookup. The rest are self-describing, and every
  // byte here is re-sent on every `tools/list`.
  revision: z.number().int().describe("Send back as expected_revision when updating."),
  project: z.string().describe("Pass as project to qualify this key."),
  document: z.record(z.string(), z.unknown()),
  bundle: z.record(z.string(), z.unknown()).nullable(),
});

/**
 * The subject the bundle projects from.
 *
 * The loaded row is handed over rather than re-read: `get_context` has to return the
 * entity either way, so a second read inside the bundle would be a third query for a
 * document already in memory.
 */
const toSubject = (reference: EntityReference): BundleSubject => {
  const common = {
    id: reference.id,
    key: reference.key,
    title: reference.title,
    document: reference.document,
  };
  switch (reference.entity) {
    case "epic": {
      return { entity: "epic", ...common };
    }
    case "stream": {
      return { entity: "stream", ...common };
    }
    case "task": {
      // `streamId` is the column, not `links.parent_stream_id`: the column is what
      // the FK and the cascade are on, so it cannot disagree with reality.
      return { entity: "task", ...common, streamId: reference.streamId ?? "" };
    }
  }
};

const summarise = (
  reference: EntityReference,
  projectName: string,
  bundle: ContextBundle | null,
): string => {
  const lines = [
    `${reference.key} [${reference.entity}, ${reference.status}] ${reference.title}`,
    `project: ${projectName} · revision: ${String(reference.revision)} — send this as expected_revision when you update it.`,
  ];
  if (bundle) {
    lines.push(
      `context: stream ${bundle.stream?.key ?? "(none)"} · ` +
        `${String(bundle.requirements.functional.length + bundle.requirements.nonFunctional.length)} requirement(s) · ` +
        `${String(bundle.acceptanceCriteria.length)} acceptance criteri(a) · ` +
        `${String(bundle.businessRules.length)} business rule(s) · ` +
        `${String(bundle.edgeCases.length)} edge case(s) · ` +
        `${String(bundle.dependencies.blockedBy.length)} blocker(s), ${String(bundle.dependencies.blocks.length)} blocked by this.`,
    );
    if (bundle.unresolvedReferences.length > 0) {
      lines.push(
        `unresolved references: ${bundle.unresolvedReferences.join(", ")} — this entity names ids its stream does not define. Report that rather than inventing them.`,
      );
    }
  }
  lines.push("Full document and bundle are in the structured content of this result.");
  return lines.join("\n");
};

export const getContextTool = defineTool({
  name: "get_context",
  title: "Get context",
  annotations: { readOnlyHint: true },
  input: getContextInput,
  output: getContextOutput,
  run: async ({ input, scope }) => {
    const resolved = await referenceService.resolveEntityByKey(scope, {
      key: input.key,
      project: input.project,
    });
    if (!resolved.ok) {
      return keyLookupError(resolved);
    }
    const reference = resolved.reference;

    const bundle = input.include_bundle
      ? await buildContextBundle(scope, toSubject(reference))
      : null;
    const projectName = resolved.project.name;

    return structuredResult(summarise(reference, projectName, bundle), {
      entity: reference.entity,
      key: reference.key,
      title: reference.title,
      status: reference.status,
      revision: reference.revision,
      project: projectName,
      document: reference.document,
      bundle,
    });
  },
});
