import Elysia from "elysia";
import { z } from "zod";
import {
  epicStatusSchema,
  linkableEntityTypeSchema,
  milestoneStatusSchema,
  relationshipTypeSchema,
  ruleStatusSchema,
  streamStatusSchema,
  streamTypeSchema,
  taskStatusSchema,
  taskTypeSchema,
  versionedEntityTypeSchema,
} from "../../domain/enums";
import type { VersionedEntityType } from "../../domain/enums";
import type { Epic } from "../../domain/repository/epic";
import type { Milestone } from "../../domain/repository/milestone";
import type { Rule } from "../../domain/repository/rule";
import type { Stream } from "../../domain/repository/stream";
import type { Task } from "../../domain/repository/task";
import { loadProjectAggregate } from "../../domain/service/projectAggregate";
import { pruneForAggregate } from "../../domain/service/readProjection";
import { findProjectEntity } from "../../domain/service/projectEntity";
import {
  countProjectFragments,
  loadEntityFragments,
  loadFragmentPage,
  type FragmentEntry,
} from "../../domain/service/projectFragments";
import { SECTION_IDS, readRuleApplications, readSources } from "../../domain/service/specFragment";
import { SEARCH_GROUPS, searchProject } from "../../domain/service/projectSearch";
import { loadRevisionPage } from "../../domain/service/revisionLog";
import { streamRepository } from "../../domain/repository/stream";
import { asRecord, asText } from "../../domain/service/documentValue";
import { authScope } from "../plugin/authScope";

/**
 * The read-only project aggregate: one call returns everything the web UI needs
 * to draw a project board — the E→S→T ownership tree, the parallel roadmap and
 * the canonical Rule catalogue.
 *
 * Same three properties as `handler/workspace.ts`, and for the same reasons:
 * this aggregate is read-only (versioned-entity writes remain MCP change-set
 * only; the separate project-container POST cannot alter them), the only tenant
 * key is the `scope` `authScope` resolved from a verified session, and every row
 * is mapped through an explicit Zod v4 DTO rather than returned raw.
 *
 * The DTO mapping is doing real work here, not ceremony. The entity rows carry a
 * `searchVector` column (a generated `tsvector`, meaningless to a client and
 * large) and the project row carries the five key counters, which are the
 * change-set engine's bookkeeping. Neither reaches the wire, and because the
 * DTOs are `strictObject` Elysia answers **422** rather than leaking a field if
 * a mapper is ever extended without extending its schema.
 *
 * Mounted at `/workspace/projects/:projectId` rather than a top-level
 * `/projects/…` so the path stays consistent with the list this drills into
 * (`GET /workspace/projects`), and so Eden Treaty reads as one chain:
 * `api.workspace.projects.get()` and `api.workspace.projects({ projectId }).get()`.
 */

/**
 * The entity document, passed through as-is.
 *
 * Typed `Record<string, unknown>` and not one of the Zod content schemas on
 * purpose: this endpoint is a *window*, and a document written before a schema
 * change must still be readable. Validating it here would turn a historical
 * document into a 422 on a page that only wants to display it. The change-set
 * pipeline is where a document is held to its schema.
 */
const documentDto = z.record(z.string(), z.unknown());

/**
 * A local use of one canonical Rule, lifted out of the document.
 *
 * It stays in the aggregate while the rest of `content` leaves, because the Rules
 * screen lists every entity that names a Rule — a project-wide question no per-entity
 * fetch can answer. It is also small: ids and two optional sentences.
 */
const RuleApplicationDto = z.strictObject({
  id: z.string(),
  ruleKey: z.string(),
  appliesWhen: z.string().nullable(),
  application: z.string().nullable(),
});

/**
 * One fragment, already extracted.
 *
 * `shape` is the discriminated union the renderer switches on — a criterion arrives
 * as given/when/then rather than as a sentence a client would have to re-split.
 * `anchor` is always present: a local id is unique only inside its owner, so it is
 * the only globally addressable form.
 */
const SpecShapeDto = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("statement"), text: z.string() }),
  z.strictObject({
    kind: z.literal("criterion"),
    given: z.string(),
    when: z.string(),
    // The domain's given/when/then vocabulary and part of the wire format, so not
    // renameable. Nothing awaits a Zod shape.
    // oxlint-disable-next-line unicorn/no-thenable
    then: z.string(),
  }),
  z.strictObject({ kind: z.literal("condition"), condition: z.string(), outcome: z.string() }),
  z.strictObject({
    kind: z.literal("transition"),
    preamble: z.strictObject({ label: z.string(), items: z.array(z.string()) }).nullable(),
    from: z.string(),
    to: z.string(),
  }),
  z.strictObject({
    kind: z.literal("workflow"),
    actor: z.string().nullable(),
    preconditions: z.array(z.string()),
    steps: z.array(
      z.strictObject({ id: z.string(), action: z.string(), result: z.string().nullable() }),
    ),
  }),
]);

const SpecFragmentDto = z.strictObject({
  owner: z.string(),
  ownerType: versionedEntityTypeSchema,
  ownerTitle: z.string(),
  id: z.string(),
  anchor: z.string(),
  section: z.enum(SECTION_IDS),
  shape: SpecShapeDto,
  marks: z.strictObject({
    priority: z.string().nullable(),
    severity: z.string().nullable(),
    method: z.string().nullable(),
    category: z.string().nullable(),
    state: z.string().nullable(),
  }),
  verifies: z.array(z.string()),
  details: z.array(z.strictObject({ label: z.string(), text: z.string() })),
  evidence: z.strictObject({ basis: z.string(), sourceIds: z.array(z.string()) }).nullable(),
  implementedBy: z.array(z.string()),
});

/** The fields every versioned entity shares, so their DTOs cannot drift. */
const entityDtoShape = {
  id: z.uuid(),
  key: z.string(),
  title: z.string(),
  summary: z.string().nullable(),
  revision: z.int().positive(),
  document: documentDto,
  ruleApplications: z.array(RuleApplicationDto),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
};

/**
 * `streamId` and `epicId` are carried even though the response is already
 * nested. The UI flattens this tree into lookup maps to filter client-side, and
 * a flattened task with no way back to its stream cannot render a breadcrumb in
 * the detail drawer. Two fields is cheaper than a second request.
 */
const TaskDto = z.strictObject({
  ...entityDtoShape,
  streamId: z.uuid(),
  status: taskStatusSchema,
  taskType: taskTypeSchema,
});

const StreamDto = z.strictObject({
  ...entityDtoShape,
  epicId: z.uuid(),
  status: streamStatusSchema,
  streamType: streamTypeSchema,
  tasks: z.array(TaskDto),
});

const EpicDto = z.strictObject({
  ...entityDtoShape,
  status: epicStatusSchema,
  streams: z.array(StreamDto),
});

const RuleDto = z.strictObject({
  ...entityDtoShape,
  status: ruleStatusSchema,
});

/** A roadmap reference, not a second owner or a copy of the Stream document. */
const MilestoneStreamDto = z.strictObject({
  id: z.uuid(),
  key: z.string(),
  title: z.string(),
  status: streamStatusSchema,
  streamType: streamTypeSchema,
  epicKey: z.string(),
  roadmapRank: z.int().nullable(),
});

const MilestoneDto = z.strictObject({
  ...entityDtoShape,
  status: milestoneStatusSchema,
  roadmapOrder: z.int(),
  streams: z.array(MilestoneStreamDto),
});

const ProjectDto = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

/**
 * One stored relationship, both ends named by public key.
 *
 * `relationship` is on the wire verbatim. `blocked_by` is the only type that
 * claims an order, and a client that cannot tell it from `related_to` would have
 * to either draw every link as a blocker or draw none of them — both of which
 * misreport the graph.
 */
const ProjectLinkDto = z.strictObject({
  sourceType: linkableEntityTypeSchema,
  sourceKey: z.string(),
  targetType: linkableEntityTypeSchema,
  targetKey: z.string(),
  relationship: relationshipTypeSchema,
  reason: z.string().nullable(),
});

const ProjectAggregateDto = z.strictObject({
  project: ProjectDto,
  /**
   * How many addressable fragments the project holds.
   *
   * One integer rather than the fragments themselves. The sidebar badge, the Overview
   * and Settings all want the size of the corpus and none of them wants its text; the
   * fragment endpoint answers everything else.
   */
  fragmentCount: z.int().min(0),
  epics: z.array(EpicDto),
  milestones: z.array(MilestoneDto),
  rules: z.array(RuleDto),
  links: z.array(ProjectLinkDto),
});

/** Entry counts for one section of the document, before and after. */
const SectionDeltaDto = z.strictObject({
  section: z.string(),
  from: z.int().min(0),
  to: z.int().min(0),
});

/**
 * One revision, already diffed.
 *
 * The document snapshots that produced `sectionDeltas` stay on the server: a
 * client that received them would be holding the project's entire history to
 * answer a question the server had both sides of.
 */
const RevisionEntryDto = z.strictObject({
  entityType: versionedEntityTypeSchema,
  entityKey: z.string(),
  title: z.string(),
  revision: z.int().positive(),
  kind: z.enum(["created", "status", "structure", "text"]),
  status: z.string(),
  statusChanged: z.boolean(),
  sectionDeltas: z.array(SectionDeltaDto),
  changedBy: z.string(),
  changeReason: z.string().nullable(),
  createdAt: z.iso.datetime(),
});

/**
 * One page of the revision log.
 *
 * `total` is the count *after* filtering and before the page is cut, so the screen
 * can say "26–50 of 590" without a second request — and so a filter that matches
 * nothing is distinguishable from a page past the end.
 *
 * `actors` and `earliest`/`latest` describe the whole filtered set rather than the
 * page. A filter control built from one page would offer options that vanish when
 * you turn it, which is worse than no control.
 */
const RevisionPageDto = z.strictObject({
  revisions: z.array(RevisionEntryDto),
  total: z.int().min(0),
  offset: z.int().min(0),
  limit: z.int().min(1),
  actors: z.array(z.strictObject({ actor: z.string(), count: z.int().min(0) })),
  reasonCount: z.int().min(0),
  earliest: z.string().nullable(),
  latest: z.string().nullable(),
});

/** What a revision page may be narrowed by. Every one is applied before paging. */
const RevisionQuery = z.object({
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(200).default(25),
  from: z.string().optional(),
  to: z.string().optional(),
  entityType: versionedEntityTypeSchema.optional(),
  kind: z.enum(["created", "status", "structure", "text"]).optional(),
  actor: z.string().optional(),
  entityKey: z.string().optional(),
});

const SourceDto = z.strictObject({
  id: z.string(),
  type: z.string(),
  reference: z.string(),
  snapshot: z.string().nullable(),
  supersedes: z.array(z.string()),
  supersededBy: z.array(z.string()),
});

/**
 * One entity, whole: the document, its extracted fragments and its Sources.
 *
 * All three together because a page that wants one wants the others — a Specification
 * is its fragments beside the Sources they cite — and three requests for one screen
 * would be three chances to render half of it.
 */
const EntityDocumentDto = z.strictObject({
  entityType: versionedEntityTypeSchema,
  key: z.string(),
  title: z.string(),
  revision: z.int().positive(),
  document: documentDto,
  fragments: z.array(SpecFragmentDto),
  sources: z.array(SourceDto),
  /**
   * For a Task: the parent Stream's fragments, so the page can quote what the Task
   * implements rather than paraphrase it. Empty for every other kind.
   */
  targetFragments: z.array(SpecFragmentDto),
});

const EntityNotFoundDto = z.strictObject({
  error: z.literal("entity_not_found"),
  message: z.string(),
});

const FragmentPageDto = z.strictObject({
  fragments: z.array(SpecFragmentDto),
  total: z.int().min(0),
  offset: z.int().min(0),
  limit: z.int().min(1),
  sectionCounts: z.array(z.strictObject({ section: z.string(), count: z.int().min(0) })),
  ownerCount: z.int().min(0),
});

const FragmentQuery = z.object({
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(20),
  section: z.string().optional(),
  owner: z.string().optional(),
  q: z.string().optional(),
});

/** One hit, carrying the rule it matched on so the ordering stays checkable. */
const SearchHitDto = z.strictObject({
  target: z.string(),
  display: z.string(),
  group: z.enum(SEARCH_GROUPS),
  title: z.string(),
  kind: z.string(),
  path: z.string(),
  status: z.string().nullable(),
  excerpt: z.string().nullable(),
  score: z.int().min(0),
  rankLabel: z.string(),
});

const SearchResultDto = z.strictObject({
  hits: z.array(SearchHitDto),
  total: z.int().min(0),
  cap: z.int().min(1),
  indexed: z.int().min(0),
});

const SearchQuery = z.object({
  q: z.string().default(""),
  limit: z.coerce.number().int().min(1).max(200).default(60),
});

const ProjectNotFoundDto = z.strictObject({
  error: z.literal("project_not_found"),
  message: z.string(),
});

/**
 * `Date` columns become ISO-8601 strings explicitly rather than by whatever
 * `JSON.stringify` would have done, so the DTO's `z.iso.datetime()` is the thing
 * that defines the wire format instead of describing an accident.
 */
function entityFields(entity: VersionedEntityType, row: Epic | Stream | Task | Milestone | Rule) {
  return {
    id: row.id,
    key: row.key,
    title: row.title,
    summary: row.summary,
    revision: row.revision,
    // Pruned, not reshaped. The sections nothing on the read surface renders are
    // dropped here; `GET /entities/:key` still returns the document whole.
    document: pruneForAggregate(entity, row.document),
    ruleApplications: readRuleApplications(row.document).map((use) => ({ ...use })),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Copies a fragment into mutable shape for the response.
 *
 * The domain returns `readonly` arrays at every level and Elysia's response type is
 * invariant in array mutability, so the copy is structural rather than cosmetic. It
 * is also the one place the wire shape of a fragment is written down.
 */
function toFragmentDto(entry: FragmentEntry) {
  const { shape } = entry;
  return {
    owner: entry.owner,
    ownerType: entry.ownerType,
    ownerTitle: entry.ownerTitle,
    id: entry.id,
    anchor: entry.anchor,
    section: entry.section,
    shape:
      shape.kind === "workflow"
        ? {
            kind: shape.kind,
            actor: shape.actor,
            preconditions: [...shape.preconditions],
            steps: shape.steps.map((step) => ({ ...step })),
          }
        : shape.kind === "transition"
          ? {
              kind: shape.kind,
              preamble: shape.preamble
                ? { label: shape.preamble.label, items: [...shape.preamble.items] }
                : null,
              from: shape.from,
              to: shape.to,
            }
          : { ...shape },
    marks: { ...entry.marks },
    verifies: [...entry.verifies],
    details: entry.details.map((detail) => ({ ...detail })),
    evidence: entry.evidence
      ? { basis: entry.evidence.basis, sourceIds: [...entry.evidence.sourceIds] }
      : null,
    implementedBy: [...entry.implementedBy],
  };
}

export const projectHandler = new Elysia({ prefix: "/workspace/projects" })
  .use(authScope)
  .get(
    "/:projectId",
    async ({ scope, params, status }) => {
      const [aggregate, fragmentCount] = await Promise.all([
        loadProjectAggregate(scope, params.projectId),
        countProjectFragments(scope, params.projectId),
      ]);
      if (!aggregate) {
        // A project id from another tenant is answered identically to one that does
        // not exist — the scope is inside the `WHERE`, so the two are not
        // distinguishable here and must not become distinguishable by accident.
        return status(404, {
          error: "project_not_found" as const,
          message: "No project with that id exists in this workspace.",
        });
      }

      return {
        project: {
          id: aggregate.project.id,
          name: aggregate.project.name,
          createdAt: aggregate.project.createdAt.toISOString(),
          updatedAt: aggregate.project.updatedAt.toISOString(),
        },
        epics: aggregate.epics.map((epicNode) => ({
          ...entityFields("epic", epicNode.epic),
          status: epicNode.epic.status,
          streams: epicNode.streams.map((streamNode) => ({
            ...entityFields("stream", streamNode.stream),
            epicId: streamNode.stream.epicId,
            status: streamNode.stream.status,
            streamType: streamNode.stream.streamType,
            tasks: streamNode.tasks.map((taskRow) => ({
              ...entityFields("task", taskRow),
              streamId: taskRow.streamId,
              status: taskRow.status,
              taskType: taskRow.taskType,
            })),
          })),
        })),
        milestones: aggregate.milestones.map((milestoneNode) => ({
          ...entityFields("milestone", milestoneNode.milestone),
          status: milestoneNode.milestone.status,
          roadmapOrder: milestoneNode.milestone.roadmapOrder,
          streams: milestoneNode.streams.map((streamRow) => ({
            id: streamRow.id,
            key: streamRow.key,
            title: streamRow.title,
            status: streamRow.status,
            streamType: streamRow.streamType,
            epicKey: streamRow.epicKey,
            roadmapRank: streamRow.roadmapRank,
          })),
        })),
        rules: aggregate.rules.map((ruleRow) => ({
          ...entityFields("rule", ruleRow),
          status: ruleRow.status,
        })),
        // Spread rather than passed through: the domain returns `readonly` arrays,
        // and Elysia's response type is invariant in the array's mutability.
        links: [...aggregate.links],
        fragmentCount,
      };
    },
    {
      // Zod v4, never Elysia's `t`. This is load-bearing rather than cosmetic: the
      // id goes straight into a `uuid` comparison, so without it a non-uuid path
      // segment reaches Postgres and turns a client mistake into a 500.
      params: z.strictObject({ projectId: z.uuid() }),
      response: { 200: ProjectAggregateDto, 404: ProjectNotFoundDto },
    },
  )
  /**
   * The revision log, on its own path rather than inside the aggregate.
   *
   * Separate because the cost profile is different: the aggregate is read on every
   * navigation, while the history is read by the one screen that shows it. Folding
   * several hundred diffed revisions into the payload every page would pay for a
   * screen the reader is usually not on.
   *
   * No `404` branch: `loadRevisionLog` filters on `(workspace_id, project_id)`, so
   * a project that does not exist in this scope has no revisions and answers with
   * an empty list. That is the same information a 404 would carry, without making
   * "does this project exist" separately probeable.
   */
  .get(
    "/:projectId/revisions",
    async ({ scope, params, query }) => {
      const page = await loadRevisionPage(scope, params.projectId, query);
      // Mapped rather than passed through, like every other DTO in this file. The
      // domain returns `readonly` arrays at both levels and Elysia's response type
      // is invariant in array mutability, so the nested one is copied too.
      return {
        ...page,
        revisions: page.revisions.map((entry) => ({
          ...entry,
          sectionDeltas: [...entry.sectionDeltas],
        })),
        actors: page.actors.map((entry) => ({ ...entry })),
      };
    },
    {
      params: z.strictObject({ projectId: z.uuid() }),
      query: RevisionQuery,
      response: { 200: RevisionPageDto },
    },
  )
  /**
   * One entity's document, whole.
   *
   * The aggregate carries a pruned copy — see `readProjection.ts` — so a screen
   * that needs a section the aggregate drops asks for that one entity. It is one
   * small request on a page that is already about one entity, rather than a cost
   * every other screen pays on every navigation.
   */
  .get(
    "/:projectId/entities/:key",
    async ({ scope, params, status }) => {
      const found = await findProjectEntity(scope, params.projectId, params.key);
      if (!found) {
        return status(404, {
          error: "entity_not_found" as const,
          message: "No entity with that key exists in this project.",
        });
      }
      // A Task's targets live in its parent Stream, and the fragment loader addresses
      // owners by key while the document stores the parent as a uuid — so the row is
      // read to translate one into the other.
      const parentId =
        found.entityType === "task" ? asText(asRecord(found.document.links).parent_stream_id) : "";
      const parent = parentId.length > 0 ? await streamRepository.findById(scope, parentId) : null;
      const parentKey = parent?.key ?? null;
      const [fragments, targetFragments] = await Promise.all([
        loadEntityFragments(scope, params.projectId, params.key),
        parentKey === null
          ? Promise.resolve([])
          : loadEntityFragments(scope, params.projectId, parentKey),
      ]);
      return {
        ...found,
        targetFragments: targetFragments.map(toFragmentDto),
        fragments: fragments.map(toFragmentDto),
        sources: readSources(found.document).map((source) => ({
          ...source,
          supersedes: [...source.supersedes],
          supersededBy: [...source.supersededBy],
        })),
      };
    },
    {
      params: z.strictObject({ projectId: z.uuid(), key: z.string().min(1).max(128) }),
      response: { 200: EntityDocumentDto, 404: EntityNotFoundDto },
    },
  )
  /**
   * Specification fragments, paged and already extracted.
   *
   * A fragment is not a row — it lives inside `content` as jsonb — so the browser
   * used to hold every document in order to page a list of them. This endpoint is
   * what replaces that: the section registry and the five shapes run here, once, and
   * what crosses the wire is the page plus the counts a filter control needs.
   */
  .get(
    "/:projectId/fragments",
    async ({ scope, params, query }) => {
      const page = await loadFragmentPage(scope, params.projectId, {
        offset: query.offset,
        limit: query.limit,
        section: query.section as never,
        owner: query.owner,
        q: query.q,
      });
      return {
        ...page,
        fragments: page.fragments.map(toFragmentDto),
        sectionCounts: page.sectionCounts.map((entry) => ({ ...entry })),
      };
    },
    {
      params: z.strictObject({ projectId: z.uuid() }),
      query: FragmentQuery,
      response: { 200: FragmentPageDto },
    },
  )
  /**
   * Project search, ranked, with the rule each hit matched on.
   *
   * Covers fragment text with its anchor, which the MCP `search_context` tool does
   * not: that one is entity-level and capped low so a model can scan. Two questions,
   * two endpoints.
   */
  .get(
    "/:projectId/search",
    async ({ scope, params, query }) => {
      const result = await searchProject(scope, params.projectId, {
        query: query.q,
        limit: query.limit,
      });
      return { ...result, hits: result.hits.map((hit) => ({ ...hit })) };
    },
    {
      params: z.strictObject({ projectId: z.uuid() }),
      query: SearchQuery,
      response: { 200: SearchResultDto },
    },
  );
