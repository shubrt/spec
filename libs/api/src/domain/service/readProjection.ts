import type { VersionedEntityType } from "../enums";

/**
 * What the read surface is given of a stored document.
 *
 * The project aggregate is fetched on every navigation, so what it carries is a
 * budget rather than a detail. Measured on the live workspace, the documents came
 * to 597 KB and broke down like this:
 *
 *   143 KB  the envelope — `entity`, `schema_version`, `links` and a `meta` whose
 *           id, key, title, status and revision the DTO already carries as real
 *           columns beside the document. Pure duplication on the wire.
 *    86 KB  Task `implementation` — the technical body, rendered by one page.
 *
 * `verification` and `done_when` stay, at 42 KB, because the screens count them:
 * moving them out would mean carrying a count beside the document, and a number
 * that has to agree with a list it no longer travels with is a number that will one
 * day disagree.
 *
 * So the aggregate ships the document with those parts removed. It is still the
 * document, in the same shape, parsed by the same code; it is simply not carrying
 * a Task's implementation essay to a screen that shows a number.
 *
 * ## What this is not
 *
 * It is not validation and it is not a schema. A key this file has never heard of
 * passes through untouched, because the endpoint remains a window: a document
 * written before a schema change has to stay readable rather than being silently
 * reshaped on the way out. Only the named parts are dropped, and only from the
 * aggregate.
 *
 * ## Where the dropped parts went
 *
 * `GET /workspace/projects/:projectId/entities/:key` returns the document whole. A
 * screen that wants a Task's approach, steps or technical decisions asks for that
 * one entity — one small request on a page that is already about one entity, rather
 * than a cost every other screen pays on every navigation.
 */

/**
 * The `meta` fields the read surface reads.
 *
 * `priority` only. `id`, `key`, `title`, `status` and `revision` are columns on the
 * row and are already beside the document in every DTO, so carrying them inside it
 * as well is the same value twice — and the two could not disagree, because the
 * server stamps the document from the row.
 *
 * `stream_type` and `task_type` are likewise columns. `size`, `milestone_key` and
 * `roadmap_rank` are carried by the aggregate's own fields.
 */
const KEPT_META = ["priority"] as const;

/** Top-level keys no read surface consumes. */
const PRUNED_ENVELOPE = [
  // Both are constants of the entity kind, which the DTO already names.
  "entity",
  "schema_version",
  // Graph relationships live in `entity_link` and reach the client as the
  // aggregate's `links`. The document's copy is parent ownership, which the
  // nesting already expresses.
  "links",
] as const;

/**
 * Sections removed from each entity kind's `content`.
 *
 * Every entry is here because nothing in the read surface renders it, and each one
 * is reachable through the per-entity endpoint. Adding a screen that needs one means
 * removing it from this list — a visible, deliberate act rather than a payload that
 * quietly grew back.
 */
const PRUNED_CONTENT: Partial<Record<VersionedEntityType, readonly string[]>> = {
  task: [
    // The technical body. Large, and shown only on the Task's own page, which
    // fetches the whole document for it.
    "implementation",
    // Prose prerequisites. Task-to-task ordering is an edge in `entity_link`, and
    // that is what every dependency column reads.
    "dependencies",
    "artifacts",
  ],
};

/**
 * Entity kinds whose `provenance` the aggregate carries.
 *
 * A Stream's Sources are listed beside its Specification, and an Epic's fragments
 * cite them. Nothing renders a Task's, a Rule's or a Milestone's source list, so
 * those travel only with the whole document.
 */
const KEEPS_PROVENANCE = new Set<VersionedEntityType>(["epic", "stream"]);

/** `execution` fields the read surface reads. The trace pins are a server audit. */
const KEPT_EXECUTION = ["estimate", "assignee", "executor_kind", "long_running"] as const;

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const without = (
  source: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> => {
  const next = { ...source };
  for (const key of keys) delete next[key];
  return next;
};

const onlyKeys = (
  source: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> => {
  const next: Record<string, unknown> = {};
  for (const key of keys) {
    if (source[key] !== undefined) next[key] = source[key];
  }
  return next;
};

/** The document as the aggregate carries it. */
export function pruneForAggregate(
  entity: VersionedEntityType,
  document: Record<string, unknown>,
): Record<string, unknown> {
  const next = without(document, PRUNED_ENVELOPE);

  next.meta = onlyKeys(asRecord(document.meta), KEPT_META);

  const contentKeys = PRUNED_CONTENT[entity];
  if (contentKeys) {
    next.content = without(asRecord(document.content), contentKeys);
  }

  if (!KEEPS_PROVENANCE.has(entity)) {
    delete next.provenance;
  }

  if (entity === "task" && document.execution !== undefined) {
    next.execution = onlyKeys(asRecord(document.execution), KEPT_EXECUTION);
  }

  return next;
}
