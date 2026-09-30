import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { HIERARCHY_ENTITY_TYPE, STREAM_TYPE, TASK_TYPE, VERSIONED_ENTITY_TYPE } from "../enums";
import type { DocumentSchemaTarget } from "../schema/document";
import { documentJsonSchema } from "../schema/jsonSchema";
import { type DocumentSchemaSelection, resolveDocumentSchemaTarget } from "../schema/target";
import { CONFIRM_RULE, DECISION_RULE, HIERARCHY, UNKNOWN_RULE, WHAT_VS_HOW } from "./fragments";

/**
 * Tier 3 of three (domain spec §10.5): the long form, fetched only when a model
 * decides it needs it.
 *
 * This is where text goes that does not fit tier 1 (`SERVER_INSTRUCTIONS`, paid
 * for on every turn) or tier 2 (a tool `description`, paid for on every
 * `tools/list`). A resource costs nothing until it is read, so text that exceeds
 * either budget belongs *here* instead of raising that budget.
 */

type GuideResource = {
  /** The last segment of `spec://guide/<slug>`. */
  slug: string;
  title: string;
  description: string;
  text: string;
};

const GUIDES: readonly GuideResource[] = [
  {
    slug: "hierarchy",
    title: "Hierarchy and glossary",
    description: "What an epic, a stream and a task are, and which one to reach for.",
    text: [
      HIERARCHY,
      "Workspace and project are containers for access, isolation and grouping. They carry no " +
        "document and no revision. The three entity kinds that do are: " +
        `${VERSIONED_ENTITY_TYPE.join(", ")}. The ownership hierarchy itself remains ` +
        `${HIERARCHY_ENTITY_TYPE.join(" -> ")}; Rules and Milestones are project-level overlays.`,
      "An epic stays active for as long as its capability exists and takes on new streams over " +
        "time. Finishing a stream does not finish its epic, which is why an epic has no 'done' " +
        "status — only active, paused and archived. New bugs, extensions and investigations " +
        "become new streams under the same epic rather than reopening an old one.",
      "A stream answers: what should be achieved, why it matters, what is in scope, what is " +
        "explicitly out of scope, which business workflows exist, which rules and edge cases " +
        "apply, and how success is recognised. An early stream may legitimately be an " +
        "incomplete draft — for an experiment or an investigation the requirements are not " +
        "knowable up front.",
      "A task describes the technical goal, the components and interfaces it touches, the " +
        "approach, the decisions and alternatives, its dependencies, its tests and verification, " +
        "and the artefacts it is expected to produce. A ready Task references at least one typed " +
        "business target in its parent Stream.",
      "A Rule is one canonical project constraint with its own revision history. Epics and " +
        "Streams reference it through local applications. A Milestone groups Streams into an " +
        "advisory roadmap with explicit exit criteria; it is never a dependency or deadline.",
      `${STREAM_TYPE.join(", ")} are the stream types. ${TASK_TYPE.join(", ")} are the task types.`,
      "There are no mandatory intermediate levels. Do not add sub-tasks, features or stories as " +
        "extra tiers, and do not nest tasks inside a stream document — a task is its own entity " +
        "linked to its stream.",
    ].join("\n\n"),
  },
  {
    slug: "separation",
    title: "Business and technical separation",
    description: "The what/why vs how rule, with both 'belongs in' lists in full.",
    text: [
      WHAT_VS_HOW,
      "Belongs in an Epic or Stream: purpose; business problem; scope and exclusions; outcomes; " +
        "functional requirements; non-functional requirements and measurable quality targets; " +
        "workflows; Rule applications; edge cases; business dependencies; acceptance or success " +
        "criteria; open questions and assumptions.",
      "Belongs in a task: frameworks and libraries; concrete files and modules; API endpoints; " +
        "database tables and migrations; technical architecture; implementation decisions; test " +
        "files and test strategy; deployment steps; concrete branches and environments.",
      "A non-functional requirement is not an implementation detail. 'Search must answer within " +
        "500 ms at 100,000 products' is stream content; 'build a search index and implement the " +
        "query endpoint with cursor pagination' is task content.",
      "A specific technology may appear as business content when it is a binding constraint. It " +
        "then has to be recorded as a constraint with the reason it is one, not dropped in as an " +
        "incidental implementation detail.",
    ].join("\n\n"),
  },
  {
    slug: "change-sets",
    title: "Change sets",
    description: "The full shape of each operation, and the order to apply a change set in.",
    text: [
      "A change set is one coherent intent expressed as an ordered list of operations, applied " +
        "atomically: either all of them land or none does. It carries a `reason` in the user's " +
        "own terms. Entity document writes store it with their revision and a new link stores it " +
        "on the edge; unlink has no separate audit record in this MVP.",
      "operation: 'create' — requires `entity` and `data`. `parent` names the project for an " +
        "Epic, Rule or Milestone, the Epic for a Stream, or the Stream for a Task. A Milestone " +
        "also needs `roadmap_order`. Optional `project` disambiguates a hierarchy parent. " +
        "Optional `key` is a `$temp_id`, not a requested real key; " +
        "later operations in the same set can use it as `parent`, `source` or `target`.",
      "operation: 'update' — requires the existing `key`, `expected_revision`, and at least " +
        "one of `data`, `items` or `rebase_stream_revision: true`. Sent data sections replace complete sections. `items` bundles " +
        "complete-element add, replace, and remove actions on registered id-bearing arrays into " +
        "one owner revision. It is not an upsert or leaf merge. Rebase is Task-only, requires " +
        "`confirm: true`, and explicitly moves already-started nonterminal work to its current Parent-Stream revision.",
      "operation: 'link' or 'unlink' — requires `source`, `target` and `relationship`; optional " +
        "`project` disambiguates existing keys. Each endpoint is an existing key or a `$temp_id` " +
        "created earlier in the same set.",
      "operation: 'archive' or 'delete' — requires the existing `key`, `expected_revision` and " +
        "`confirm: true` after explicit user approval. Optional `project` disambiguates the key.",
      "operation: 'move' — requires the existing `key`, its `expected_revision`, the new `parent` " +
        "and `confirm: true` after explicit user approval. Optional `project` disambiguates the " +
        "target; optional `parent_project` independently disambiguates the new parent. Public keys " +
        "stay stable, so a cross-Project subtree move is refused if any moved E/S/T key already exists at the destination.",
      "operation: 'schedule' — reorders a Milestone with `roadmap_order`, or assigns/reorders a " +
        "Stream with `milestone` and `roadmap_rank`. Set `milestone: null` to return a Stream to " +
        "Backlog. An existing key needs `expected_revision`; a `$temp` Stream created earlier in " +
        "the set omits it. Roadmap positions are advisory and never create a dependency.",
      "Order of work: read the existing context, classify what the user is asking for, assemble " +
        "the change set, dry-run it with validate_change_set, show the user what will change, " +
        "then submit it to apply_change_set, adding `confirm: true` only to each archive, delete, " +
        "move, rebase, id-removing update, or impacting Rule update the user approved. The apply result reports ids, keys " +
        "and new revisions for the entities it touched; its values are authoritative.",
      "Field shapes for `data` are not listed here — call get_entity_schema, or read the " +
        "spec://schema/ resources. Those schemas describe the composed agent document. When " +
        "forming create/update `data`, omit `entity`, `schema_version` and `links`: create " +
        "derives them from the operation's `entity` and `parent`, while update accepts only the " +
        "sections to replace. The server validates the composed result.",
    ].join("\n\n"),
  },
  {
    slug: "conventions",
    title: "Working conventions",
    description:
      "Unknown information, decisions that are the user's, confirmation, revisions, and what not to do.",
    text: [
      UNKNOWN_RULE,
      DECISION_RULE,
      "Working a decision: name the options, say which one you would pick and why, show the " +
        "trade-offs, then ask. Once the user has chosen, record it as a " +
        "content.implementation.technical_decisions entry with its reason and the alternatives " +
        "considered — the alternatives are what shows the choice was made rather than assumed. " +
        "While it is open, keep it in content.open_questions, add an assumption only if work has " +
        "to continue without the answer, and leave the Task at draft or planned. When the " +
        "decision is itself the work, make it a Task of type decision instead of resolving it " +
        "silently; when it keeps applying beyond this Stream, record it as an R-key.",
      CONFIRM_RULE,
      "Never overwrite a newer revision. Every update states the revision it was based on; if " +
        "that revision is stale the change is rejected, and the correct response is to re-read " +
        "the entity and rebuild the change set — not to retry the same write.",
      "Avoid, in order of how much damage each does: a single free-text description field used " +
        "as the real content; technical detail in a business Stream that is not a recorded " +
        "constraint; a ready Task with no typed reference to its Stream's business target; Tasks " +
        "nested as arrays inside a Stream document; an artificial user-story shape imposed on a " +
        "bug, experiment or investigation; and behavioural rules kept only in a local prompt " +
        "instead of a canonical R-key.",
      "These descriptions guide a model; they are not the validation layer. The server " +
        "validates independently and will reject what it must, so read validate_change_set's " +
        "output as the authority.",
    ].join("\n\n"),
  },
];

const ENTITY_SCHEMA_URI_TEMPLATE = "spec://schema/{entity}";
const STREAM_SCHEMA_URI_TEMPLATE = "spec://schema/stream/{streamType}";
const SCHEMA_MIME_TYPE = "application/schema+json";

type SchemaResource = {
  readonly selection: DocumentSchemaSelection;
  readonly target: DocumentSchemaTarget;
  readonly uri: string;
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly mimeType: typeof SCHEMA_MIME_TYPE;
};

const schemaResource = (selection: DocumentSchemaSelection): SchemaResource => {
  const target = resolveDocumentSchemaTarget(selection);

  if (selection.entity === "stream") {
    return {
      selection,
      target,
      uri: `spec://schema/stream/${selection.streamType}`,
      name: `schema-stream-${selection.streamType}`,
      title: `JSON Schema for ${selection.streamType} stream`,
      description: `Composed agent-document JSON Schema for a ${selection.streamType} stream, including its type-specific sections. Change-set data omits entity, schema_version and links; parent supplies hierarchy.`,
      mimeType: SCHEMA_MIME_TYPE,
    };
  }

  return {
    selection,
    target,
    uri: `spec://schema/${selection.entity}`,
    name: `schema-${selection.entity}`,
    title: `JSON Schema for ${selection.entity}`,
    description: `Composed agent-document JSON Schema for an ${selection.entity}. Change-set data omits entity, schema_version and links; create derives them from the operation.`,
    mimeType: SCHEMA_MIME_TYPE,
  };
};

/** Every concrete, discoverable document schema in stable wire order. */
const SCHEMA_RESOURCES: readonly SchemaResource[] = [
  schemaResource({ entity: "epic" }),
  schemaResource({ entity: "task" }),
  schemaResource({ entity: "rule" }),
  schemaResource({ entity: "milestone" }),
  ...STREAM_TYPE.map((streamType) => schemaResource({ entity: "stream", streamType })),
];

const listedSchemaResource = (resource: SchemaResource) => ({
  uri: resource.uri,
  name: resource.name,
  title: resource.title,
  description: resource.description,
  mimeType: resource.mimeType,
});

const readSchemaResource = (uri: URL) => {
  const resource = SCHEMA_RESOURCES.find((candidate) => candidate.uri === uri.toString());
  if (!resource) {
    throw new McpError(ErrorCode.InvalidParams, `Resource ${uri.toString()} not found`);
  }

  return {
    contents: [
      {
        uri: resource.uri,
        mimeType: resource.mimeType,
        text: JSON.stringify(documentJsonSchema(resource.target)),
      },
    ],
  };
};

/**
 * Registers every spec resource on a server.
 *
 * Called once from `createMcpServer`, like the tool registry, so no resource file
 * registers itself and the set of resources is enumerable in one place.
 */
export function registerSpecResources(server: McpServer): void {
  for (const guide of GUIDES) {
    server.registerResource(
      `guide-${guide.slug}`,
      `spec://guide/${guide.slug}`,
      { title: guide.title, description: guide.description, mimeType: "text/markdown" },
      (uri) => ({
        contents: [{ uri: uri.toString(), mimeType: "text/markdown", text: guide.text }],
      }),
    );
  }

  server.registerResource(
    "entity-schema",
    new ResourceTemplate(ENTITY_SCHEMA_URI_TEMPLATE, {
      list: () => ({
        resources: SCHEMA_RESOURCES.filter(({ selection }) => selection.entity !== "stream").map(
          listedSchemaResource,
        ),
      }),
    }),
    {
      title: "Entity JSON Schema",
      description: "The writable JSON Schema for an Epic, Task, Rule, or Milestone document.",
      mimeType: SCHEMA_MIME_TYPE,
    },
    (uri) => readSchemaResource(uri),
  );

  server.registerResource(
    "stream-schema",
    new ResourceTemplate(STREAM_SCHEMA_URI_TEMPLATE, {
      list: () => ({
        resources: SCHEMA_RESOURCES.filter(({ selection }) => selection.entity === "stream").map(
          listedSchemaResource,
        ),
      }),
    }),
    {
      title: "Stream JSON Schema",
      description: "The writable JSON Schema for one of the seven stream types.",
      mimeType: SCHEMA_MIME_TYPE,
    },
    (uri) => readSchemaResource(uri),
  );
}

/** The stable resource URIs exposed through the SDK registry. */
export const SPEC_RESOURCE_URIS = {
  guides: GUIDES.map((guide) => `spec://guide/${guide.slug}`),
  schemas: SCHEMA_RESOURCES.map(({ uri }) => uri),
  schemaTemplate: ENTITY_SCHEMA_URI_TEMPLATE,
  streamSchemaTemplate: STREAM_SCHEMA_URI_TEMPLATE,
} as const;
