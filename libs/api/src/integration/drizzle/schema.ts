import { relations } from "drizzle-orm";
import { entityLink } from "./schema/entityLink";
import { entityRevision } from "./schema/entityRevision";
import { epic } from "./schema/epic";
import { project } from "./schema/project";
import { stream } from "./schema/stream";
import { task } from "./schema/task";
import { workspace } from "./schema/workspace";

export { entityLink } from "./schema/entityLink";
export { entityRevision } from "./schema/entityRevision";
export { epic } from "./schema/epic";
export { project } from "./schema/project";
export { stream } from "./schema/stream";
export { task } from "./schema/task";
export { workspace } from "./schema/workspace";

/**
 * Relations are declared for the hierarchy only: Workspace → Project → Epic →
 * Stream → Task, in both directions.
 *
 * `entity_link` and `entity_revision` get no relation to their endpoints on
 * purpose. Their `(entity_type, entity_id)` pairs are polymorphic, and Drizzle's
 * relational API needs a concrete pair of columns to join on — a relation that
 * points at one of the three tables would be wrong for the other two. Those two
 * tables are read through explicit queries that filter on `entity_type`.
 */
export const workspaceRelations = relations(workspace, ({ many }) => ({
  projects: many(project),
}));

export const projectRelations = relations(project, ({ one, many }) => ({
  workspace: one(workspace, {
    fields: [project.workspaceId],
    references: [workspace.id],
  }),
  epics: many(epic),
}));

export const epicRelations = relations(epic, ({ one, many }) => ({
  workspace: one(workspace, {
    fields: [epic.workspaceId],
    references: [workspace.id],
  }),
  project: one(project, {
    fields: [epic.projectId],
    references: [project.id],
  }),
  streams: many(stream),
}));

export const streamRelations = relations(stream, ({ one, many }) => ({
  workspace: one(workspace, {
    fields: [stream.workspaceId],
    references: [workspace.id],
  }),
  project: one(project, {
    fields: [stream.projectId],
    references: [project.id],
  }),
  epic: one(epic, {
    fields: [stream.epicId],
    references: [epic.id],
  }),
  tasks: many(task),
}));

export const taskRelations = relations(task, ({ one }) => ({
  workspace: one(workspace, {
    fields: [task.workspaceId],
    references: [workspace.id],
  }),
  project: one(project, {
    fields: [task.projectId],
    references: [project.id],
  }),
  stream: one(stream, {
    fields: [task.streamId],
    references: [stream.id],
  }),
}));

export const schema = {
  workspace,
  project,
  epic,
  stream,
  task,
  entityLink,
  entityRevision,
  workspaceRelations,
  projectRelations,
  epicRelations,
  streamRelations,
  taskRelations,
};
