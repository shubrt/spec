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
import { loadRevisionPage } from "../../domain/service/revisionLog";
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

/** The fields every versioned entity shares, so their DTOs cannot drift. */
const entityDtoShape = {
  id: z.uuid(),
  key: z.string(),
  title: z.string(),
  summary: z.string().nullable(),
  revision: z.int().positive(),
  document: documentDto,
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

const EntityDocumentDto = z.strictObject({
  entityType: versionedEntityTypeSchema,
  key: z.string(),
  title: z.string(),
  revision: z.int().positive(),
  document: documentDto,
});

const EntityNotFoundDto = z.strictObject({
  error: z.literal("entity_not_found"),
  message: z.string(),
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
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export const projectHandler = new Elysia({ prefix: "/workspace/projects" })
  .use(authScope)
  .get(
    "/:projectId",
    async ({ scope, params, status }) => {
      const aggregate = await loadProjectAggregate(scope, params.projectId);
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
      return found;
    },
    {
      params: z.strictObject({ projectId: z.uuid(), key: z.string().min(1).max(128) }),
      response: { 200: EntityDocumentDto, 404: EntityNotFoundDto },
    },
  );
