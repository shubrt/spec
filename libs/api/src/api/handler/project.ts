import Elysia from "elysia";
import { z } from "zod";
import {
  epicStatusSchema,
  milestoneStatusSchema,
  ruleStatusSchema,
  streamStatusSchema,
  streamTypeSchema,
  taskStatusSchema,
  taskTypeSchema,
} from "../../domain/enums";
import type { Epic } from "../../domain/repository/epic";
import type { Milestone } from "../../domain/repository/milestone";
import type { Rule } from "../../domain/repository/rule";
import type { Stream } from "../../domain/repository/stream";
import type { Task } from "../../domain/repository/task";
import { loadProjectAggregate } from "../../domain/service/projectAggregate";
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

const ProjectAggregateDto = z.strictObject({
  project: ProjectDto,
  epics: z.array(EpicDto),
  milestones: z.array(MilestoneDto),
  rules: z.array(RuleDto),
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
function entityFields(row: Epic | Stream | Task | Milestone | Rule) {
  return {
    id: row.id,
    key: row.key,
    title: row.title,
    summary: row.summary,
    revision: row.revision,
    document: row.document,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export const projectHandler = new Elysia({ prefix: "/workspace/projects" }).use(authScope).get(
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
        ...entityFields(epicNode.epic),
        status: epicNode.epic.status,
        streams: epicNode.streams.map((streamNode) => ({
          ...entityFields(streamNode.stream),
          epicId: streamNode.stream.epicId,
          status: streamNode.stream.status,
          streamType: streamNode.stream.streamType,
          tasks: streamNode.tasks.map((taskRow) => ({
            ...entityFields(taskRow),
            streamId: taskRow.streamId,
            status: taskRow.status,
            taskType: taskRow.taskType,
          })),
        })),
      })),
      milestones: aggregate.milestones.map((milestoneNode) => ({
        ...entityFields(milestoneNode.milestone),
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
        ...entityFields(ruleRow),
        status: ruleRow.status,
      })),
    };
  },
  {
    // Zod v4, never Elysia's `t`. This is load-bearing rather than cosmetic: the
    // id goes straight into a `uuid` comparison, so without it a non-uuid path
    // segment reaches Postgres and turns a client mistake into a 500.
    params: z.strictObject({ projectId: z.uuid() }),
    response: { 200: ProjectAggregateDto, 404: ProjectNotFoundDto },
  },
);
