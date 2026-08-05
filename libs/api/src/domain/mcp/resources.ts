import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { ENTITY_TYPE, STREAM_TYPE, TASK_TYPE } from "../enums";
import type { DocumentSchemaTarget } from "../schema/document";
import { documentJsonSchema } from "../schema/jsonSchema";
import {
  type DocumentSchemaSelection,
  resolveDocumentSchemaTarget,
  usesBaseStreamContentOnly,
} from "../schema/target";
import { CONFIRM_RULE, HIERARCHY, UNKNOWN_RULE, WHAT_VS_HOW } from "./fragments";

/**
 * Tier 3 of three (domain spec §10.5): the long form, fetched only when a model
 * decides it needs it.
 *
 * This is where text goes that does not fit tier 1 (`SERVER_INSTRUCTIONS`, paid
 * for on every turn) or tier 2 (a tool `description`, paid for on every
 * `tools/list`). A resource costs nothing until it is read, so the budget tests
 * failing is a signal to move prose *here*, not to raise a budget.
 */

type GuideResource = {
  /** The last segment of `zpecs://guide/<slug>`. */
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
        `${ENTITY_TYPE.join(", ")}.`,
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
        "and the artefacts it is expected to produce. A task always references the business " +
        "requirements or acceptance criteria it contributes to.",
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
      "Belongs in an epic or stream: purpose; business problem; scope and exclusions; outcomes; " +
        "functional requirements; non-functional requirements and measurable quality targets; " +
        "workflows; business rules; edge cases; business dependencies; acceptance or success " +
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
      "operation: 'create' — requires `entity` (epic, stream or task) and `data`, the document " +
        "fields for that entity. `parent` names the project for an epic, the epic for a stream, " +
        "or the stream for a task. Optional `project` disambiguates a stream or task parent. " +
        "Optional `key` is a `$temp_id`, not a requested real key; " +
        "later operations in the same set can use it as `parent`, `source` or `target`.",
      "operation: 'update' — requires the existing `key`, `expected_revision` (the revision " +
        "get_context returned) and `data` with the sections to replace. Optional `project` " +
        "disambiguates a key used by more than one project. If the entity has moved on, re-read " +
        "it and rebuild the change set rather than retrying.",
      "operation: 'link' or 'unlink' — requires `source`, `target` and `relationship`; optional " +
        "`project` disambiguates existing keys. Each endpoint is an existing key or a `$temp_id` " +
        "created earlier in the same set.",
      "operation: 'archive' or 'delete' — requires the existing `key`, `expected_revision` and " +
        "`confirm: true` after explicit user approval. Optional `project` disambiguates the key.",
      "operation: 'move' — requires the existing `key`, its `expected_revision`, the new `parent` " +
        "and `confirm: true` after explicit user approval. Optional `project` disambiguates the " +
        "target; optional `parent_project` independently disambiguates the new parent.",
      "Order of work: read the existing context, classify what the user is asking for, assemble " +
        "the change set, dry-run it with validate_change_set, show the user what will change, " +
        "then submit it to apply_change_set, adding `confirm: true` only to each archive, delete " +
        "or move operation the user approved. The apply result reports ids, keys " +
        "and new revisions for the entities it touched; its values are authoritative.",
      "Field shapes for `data` are not listed here — call get_entity_schema, or read the " +
        "zpecs://schema/ resources. Those schemas describe the composed agent document. When " +
        "forming create/update `data`, omit `entity`, `schema_version` and `links`: create " +
        "derives them from the operation's `entity` and `parent`, while update accepts only the " +
        "sections to replace. The server validates the composed result.",
    ].join("\n\n"),
  },
  {
    slug: "conventions",
    title: "Working conventions",
    description: "Unknown information, confirmation, revisions, and what not to do.",
    text: [
      UNKNOWN_RULE,
      CONFIRM_RULE,
      "Never overwrite a newer revision. Every update states the revision it was based on; if " +
        "that revision is stale the change is rejected, and the correct response is to re-read " +
        "the entity and rebuild the change set — not to retry the same write.",
      "Avoid, in order of how much damage each does: a single free-text description field used " +
        "as the real content; technical detail in a business stream that is not a recorded " +
        "constraint; a task with no reference to any requirement or acceptance criterion; tasks " +
        "nested as arrays inside a stream document; an artificial user-story shape imposed on a " +
        "bug, experiment or investigation; and behavioural rules kept only in a local prompt " +
        "instead of here.",
      "These descriptions guide a model; they are not the validation layer. The server " +
        "validates independently and will reject what it must, so read validate_change_set's " +
        "output as the authority.",
    ].join("\n\n"),
  },
];

const ENTITY_SCHEMA_URI_TEMPLATE = "zpecs://schema/{entity}";
const STREAM_SCHEMA_URI_TEMPLATE = "zpecs://schema/stream/{streamType}";
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
    const baseOnly = usesBaseStreamContentOnly(selection.streamType);
    return {
      selection,
      target,
      uri: `zpecs://schema/stream/${selection.streamType}`,
      name: `schema-stream-${selection.streamType}`,
      title: `JSON Schema for ${selection.streamType} stream`,
      description: baseOnly
        ? `Composed agent-document JSON Schema for a ${selection.streamType} stream. Change-set data omits entity, schema_version and links; parent supplies hierarchy. This type currently uses the invariant base schema; type-specific sections are not modelled yet.`
        : `Composed agent-document JSON Schema for a ${selection.streamType} stream, including its type-specific sections. Change-set data omits entity, schema_version and links; parent supplies hierarchy.`,
      mimeType: SCHEMA_MIME_TYPE,
    };
  }

  return {
    selection,
    target,
    uri: `zpecs://schema/${selection.entity}`,
    name: `schema-${selection.entity}`,
    title: `JSON Schema for ${selection.entity}`,
    description: `Composed agent-document JSON Schema for an ${selection.entity}. Change-set data omits entity, schema_version and links; create derives them from the operation.`,
    mimeType: SCHEMA_MIME_TYPE,
  };
};

/** The nine concrete, discoverable document schemas in their stable wire order. */
const SCHEMA_RESOURCES: readonly SchemaResource[] = [
  schemaResource({ entity: "epic" }),
  schemaResource({ entity: "task" }),
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
 * Registers every zpecs resource on a server.
 *
 * Called once from `createMcpServer`, like the tool registry, so no resource file
 * registers itself and the set of resources is enumerable in one place.
 */
export function registerZpecsResources(server: McpServer): void {
  for (const guide of GUIDES) {
    server.registerResource(
      `guide-${guide.slug}`,
      `zpecs://guide/${guide.slug}`,
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
      title: "Epic or task JSON Schema",
      description: "The writable JSON Schema for an epic or task document.",
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

/** The URIs a test can assert against without reaching into the SDK's registry. */
export const ZPECS_RESOURCE_URIS = {
  guides: GUIDES.map((guide) => `zpecs://guide/${guide.slug}`),
  schemas: SCHEMA_RESOURCES.map(({ uri }) => uri),
  schemaTemplate: ENTITY_SCHEMA_URI_TEMPLATE,
  streamSchemaTemplate: STREAM_SCHEMA_URI_TEMPLATE,
} as const;
