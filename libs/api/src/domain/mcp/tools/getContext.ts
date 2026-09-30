import { z } from "zod";
import { type BundleSubject, type ContextBundle, buildContextBundle } from "../../context/bundle";
import { type EntityReference, referenceService } from "../../service/reference";
import { defineTool } from "../defineTool";
import { keyLookupError, structuredResult } from "../results";

/**
 * One versioned entity by key. Work entities include projected Stream context and
 * canonical Rule definitions; Rules include direct consumers; Milestones include
 * assigned Streams. Every projection stays compact and batch-resolved.
 *
 * `project` is the key qualifier. Keys are unique per project, so a compact
 * workspace-wide candidate lookup refuses a bare key when more than one project
 * contains it; the qualifier makes that key unambiguous.
 */
const getContextInput = z.strictObject({
  key: z.string().min(1).max(64),
  project: z.string().min(1).max(200).optional(),
  include_bundle: z.boolean().default(true),
});

/**
 * Deliberately shallow.
 *
 * `document` and `bundle` are declared as objects and not spelled out, because the
 * document's real shape is 8–10 KB of generated JSON Schema per entity type. That
 * belongs in `get_entity_schema` and `spec://schema/{entity}`, served on demand, not
 * in a `tools/list` payload that is re-sent every turn under a 12 KB budget. The
 * fields below are the ones a caller needs *without* knowing the entity type —
 * above all `revision`, which every subsequent write has to send back.
 */
const getContextOutput = z.strictObject({
  entity: z.string(),
  key: z.string(),
  title: z.string(),
  status: z.string(),
  revision: z.number().int(),
  project: z.string(),
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
    status: reference.status,
    revision: reference.revision,
    projectId: reference.projectId,
    document: reference.document,
  };
  switch (reference.entity) {
    case "epic": {
      return { entity: "epic", ...common };
    }
    case "stream": {
      return {
        entity: "stream",
        ...common,
        epicId: reference.epicId ?? "",
        milestoneId: reference.milestoneId,
        roadmapRank: reference.roadmapRank,
      };
    }
    case "task": {
      // `streamId` is the column, not `links.parent_stream_id`: the column is what
      // the FK and the cascade are on, so it cannot disagree with reality.
      return { entity: "task", ...common, streamId: reference.streamId ?? "" };
    }
    case "milestone": {
      return {
        entity: "milestone",
        ...common,
        roadmapOrder: reference.roadmapOrder ?? 0,
      };
    }
    case "rule": {
      return { entity: "rule", ...common };
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
    if (bundle.kind === "hierarchy") {
      const pinned = bundle.rules.definitions.filter(
        (definition) => definition.revisionSource === "task_pin",
      ).length;
      const streamLabel =
        bundle.stream === null
          ? "(none)"
          : `${bundle.stream.key}${bundle.stream.revision === null ? "" : `@${String(bundle.stream.revision)}`} (${bundle.stream.revisionSource})`;
      lines.push(
        bundle.sectionsOmittedAsDocumentDuplicate
          ? `context: stream ${streamLabel} · own Stream sections are in document and are not duplicated in bundle · ` +
              `${String(bundle.rules.definitions.length)} canonical Rule definition(s) · ` +
              `${String(bundle.dependencies.blockedBy.length)} blocker(s), ${String(bundle.dependencies.blocks.length)} blocked by this · ` +
              `${String(bundle.relations.length)} soft relation(s).`
          : `context: stream ${streamLabel} · ` +
              `${String(bundle.requirements.functional.length + bundle.requirements.nonFunctional.length)} requirement(s) · ` +
              `${String(bundle.acceptanceCriteria.length)} acceptance criteri(a) · ` +
              `${String(bundle.rules.definitions.length)} canonical Rule definition(s) (${String(pinned)} task-pinned, ${String(bundle.rules.definitions.length - pinned)} current) · ` +
              `${String(bundle.edgeCases.length)} edge case(s) · ` +
              `${String(bundle.dependencies.blockedBy.length)} blocker(s), ${String(bundle.dependencies.blocks.length)} blocked by this · ` +
              `${String(bundle.relations.length)} soft relation(s).`,
      );
      if (
        bundle.stream !== null &&
        (bundle.stream.revisionSource === "missing_task_started" ||
          bundle.stream.revisionSource === "missing_task_used" ||
          bundle.stream.revisionSource === "not_recorded")
      ) {
        lines.push(
          `historical Stream context unavailable: ${bundle.stream.revisionSource}` +
            (bundle.stream.revision === null
              ? " — no revision was recorded; today's Stream was not substituted."
              : ` at revision ${String(bundle.stream.revision)} — today's Stream was not substituted.`),
        );
      }
      if (bundle.stream?.revisionSource === "not_applicable") {
        lines.push(
          "historical Stream context not applicable — this Task was cancelled before it recorded a start snapshot.",
        );
      }
      if (bundle.milestone !== null) {
        lines.push(
          `roadmap: ${bundle.milestone.key} [${bundle.milestone.status}, order ${String(bundle.milestone.roadmapOrder)}] · Stream rank ${String(bundle.milestone.streamRank ?? "unranked")}.`,
        );
      }
      if (bundle.unresolvedReferences.length > 0) {
        lines.push(
          `unresolved references: ${bundle.unresolvedReferences.join(", ")} — this entity names ids its stream does not define. Report that rather than inventing them.`,
        );
      }
      if (bundle.rules.unresolvedKeys.length > 0) {
        lines.push(`unresolved Rule keys: ${bundle.rules.unresolvedKeys.join(", ")}.`);
      }
      if (bundle.rules.unpinnedHistoricalKeys.length > 0) {
        lines.push(
          `missing terminal Rule pins: ${bundle.rules.unpinnedHistoricalKeys.join(", ")} — current definitions were not substituted.`,
        );
      }
      if (bundle.rules.unresolvedPinnedRevisions.length > 0) {
        lines.push(
          `missing pinned Rule revisions: ${bundle.rules.unresolvedPinnedRevisions
            .map((pin) => `${pin.key}@${String(pin.revision)}`)
            .join(", ")} — no current definition was substituted for the missing snapshot.`,
        );
      }
    } else if (bundle.kind === "milestone") {
      lines.push(
        `roadmap order: ${String(bundle.roadmapOrder)} · ${String(bundle.streams.length)} assigned Stream(s).`,
      );
    } else {
      lines.push(
        `${String(bundle.consumers.length)} direct Rule consumer(s) · ${String(bundle.relations.length)} relation(s).`,
      );
    }
    const sources =
      bundle.kind === "hierarchy"
        ? [
            ...bundle.evidenceSources.flatMap((catalog) => catalog.sources),
            ...bundle.rules.definitions.flatMap((definition) => definition.sources),
          ]
        : bundle.sources;
    const stale = sources.filter((source) => source.freshness === "stale").length;
    const unknown = sources.filter((source) => source.freshness === "unknown").length;
    if (stale > 0 || unknown > 0) {
      lines.push(
        `source freshness: ${String(stale)} stale · ${String(unknown)} unknown. Unknown is reported, never guessed to be stale or fresh.`,
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
