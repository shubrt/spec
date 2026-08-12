import { relations } from "drizzle-orm";
import { entityLink } from "./schema/entityLink";
import { entityRevision } from "./schema/entityRevision";
import { entityRevisionSummary } from "./schema/entityRevisionSummary";
import { epic } from "./schema/epic";
import { milestone } from "./schema/milestone";
import { project } from "./schema/project";
import { projectFragment } from "./schema/projectFragment";
import { rule } from "./schema/rule";
import { stream } from "./schema/stream";
import { task } from "./schema/task";
import { workspace } from "./schema/workspace";

export { entityLink } from "./schema/entityLink";
export { entityRevision } from "./schema/entityRevision";
export { entityRevisionSummary } from "./schema/entityRevisionSummary";
export { epic } from "./schema/epic";
export { milestone } from "./schema/milestone";
export { project } from "./schema/project";
export { projectFragment } from "./schema/projectFragment";
export { rule } from "./schema/rule";
export { stream } from "./schema/stream";
export { task } from "./schema/task";
export { workspace } from "./schema/workspace";

/**
 * Relations are declared for concrete foreign keys: the Workspace → Project →
 * Epic → Stream → Task hierarchy plus project Rules and Milestones, with an
 * optional Milestone placement on each Stream.
 *
 * `entity_link` and `entity_revision` get no relation to their endpoints on
 * purpose. Their `(entity_type, entity_id)` pairs are polymorphic, and Drizzle's
 * relational API needs a concrete pair of columns to join on — a relation that
 * points at one concrete table would be wrong for every other entity kind. Those
 * two tables are read through explicit queries that filter on `entity_type`.
 */
export const workspaceRelations = relations(workspace, ({ many }) => ({
  projects: many(project),
  milestones: many(milestone),
  rules: many(rule),
}));

export const projectRelations = relations(project, ({ one, many }) => ({
  workspace: one(workspace, {
    fields: [project.workspaceId],
    references: [workspace.id],
  }),
  epics: many(epic),
  milestones: many(milestone),
  rules: many(rule),
}));

export const milestoneRelations = relations(milestone, ({ one, many }) => ({
  workspace: one(workspace, {
    fields: [milestone.workspaceId],
    references: [workspace.id],
  }),
  project: one(project, {
    fields: [milestone.projectId],
    references: [project.id],
  }),
  streams: many(stream),
}));

export const ruleRelations = relations(rule, ({ one }) => ({
  workspace: one(workspace, {
    fields: [rule.workspaceId],
    references: [workspace.id],
  }),
  project: one(project, {
    fields: [rule.projectId],
    references: [project.id],
  }),
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
  milestone: one(milestone, {
    fields: [stream.milestoneId],
    references: [milestone.id],
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
  milestone,
  rule,
  stream,
  task,
  entityLink,
  entityRevision,
  entityRevisionSummary,
  projectFragment,
  workspaceRelations,
  projectRelations,
  epicRelations,
  milestoneRelations,
  ruleRelations,
  streamRelations,
  taskRelations,
};
