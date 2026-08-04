import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ENTITY_TYPE, STREAM_TYPE, TASK_TYPE } from "../enums";
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
        "own terms, which is stored with the revision.",
      "operation: 'create' — requires `entity` (epic, stream or task) and `data`, the document " +
        "fields for that entity. `key` is optional here and acts as a local alias: a later " +
        "operation in the same change set can name it as a link `source` or `target` before the " +
        "real key exists.",
      "operation: 'update' — requires `entity`, the existing `key`, `based_on_revision` (the " +
        "revision get_context returned for it) and `data` with the fields to change. If the " +
        "entity has moved on since that revision the operation is rejected; re-read it and " +
        "rebuild the change set rather than retrying.",
      "operation: 'link' — requires `source`, `target` and `relationship`. Each of source and " +
        "target is either an existing key or a local alias created earlier in the same set.",
      "Order of work: read the existing context, classify what the user is asking for, assemble " +
        "the change set, dry-run it with validate_change_set, show the user what will change, " +
        "then call apply_change_set with confirm: true. The result reports the ids, keys and new " +
        "revisions of everything it touched.",
      "Field shapes for `data` are not listed here and are not in any tool description — call " +
        "get_entity_schema, or read the zpecs://schema/ resources. They are validated on the " +
        "server either way.",
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

/**
 * `zpecs://schema/{entity}` is registered as a template with a body that says the
 * schemas are not wired yet, deliberately, for the same reason the tool bodies
 * return `not_implemented`: the URI space and the discovery path are part of the
 * seam workstream B builds on, and a client that already knows where to look
 * needs no change when the content arrives (task B10).
 */
const SCHEMA_URI_TEMPLATE = "zpecs://schema/{entity}";

function schemaPlaceholder(entity: string): string {
  return (
    `The JSON Schema for \`${entity}\` is not served yet. This resource exists so the URI is ` +
    "stable; its content arrives with the schema registry. Meanwhile call the " +
    "get_entity_schema tool, which is the supported path and reports the same gap."
  );
}

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
    new ResourceTemplate(SCHEMA_URI_TEMPLATE, {
      // Listed explicitly rather than left to enumeration: `list` is mandatory
      // in the SDK precisely so nobody forgets that a template is invisible to a
      // client without it.
      list: () => ({
        resources: ENTITY_TYPE.map((entity) => ({
          uri: `zpecs://schema/${entity}`,
          name: `schema-${entity}`,
          title: `JSON Schema for ${entity}`,
          mimeType: "application/schema+json",
        })),
      }),
    }),
    {
      title: "Entity JSON Schema",
      description: "The JSON Schema for one entity kind: epic, stream or task.",
      mimeType: "application/schema+json",
    },
    (uri, { entity }) => ({
      contents: [
        {
          uri: uri.toString(),
          mimeType: "text/plain",
          text: schemaPlaceholder(String(entity)),
        },
      ],
    }),
  );
}

/** The URIs a test can assert against without reaching into the SDK's registry. */
export const ZPECS_RESOURCE_URIS = {
  guides: GUIDES.map((guide) => `zpecs://guide/${guide.slug}`),
  schemaTemplate: SCHEMA_URI_TEMPLATE,
} as const;
