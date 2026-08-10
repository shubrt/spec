import { z } from "zod";

/**
 * The single source for every closed value set in the domain. Each set appears
 * exactly once, as an `as const` array, and both consumers derive from it:
 *
 * - the Drizzle column via `text().$type<EpicStatus>()` — never `pgEnum`,
 *   because a Postgres enum makes adding a value a migration and
 *   `drizzle-kit push` handles enum alteration poorly;
 * - the Zod validator via `z.enum(...)`, which is what `z.toJSONSchema()`
 *   turns into the `enum` the MCP client sees.
 *
 * Naming is a mechanical convention so nothing can drift silently:
 * `SNAKE_UPPER` array → `camelCaseSchema` validator → `PascalCase` type.
 * Keep all three declarations adjacent whenever a value set changes.
 */

/**
 * An epic is a long-lived business capability, not a time-boxed container, so
 * it deliberately has no `done`: finishing one of its streams does not finish
 * the epic (domain spec §3.1).
 */
export const EPIC_STATUS = ["active", "paused", "archived"] as const;
export type EpicStatus = (typeof EPIC_STATUS)[number];
export const epicStatusSchema = z.enum(EPIC_STATUS);

/** Maturity ladder from the domain spec §8, in order. */
export const STREAM_STATUS = [
  "draft",
  "planned",
  "ready",
  "in_progress",
  "blocked",
  "completed",
  "cancelled",
] as const;
export type StreamStatus = (typeof STREAM_STATUS)[number];
export const streamStatusSchema = z.enum(STREAM_STATUS);

/**
 * All seven stream types from the domain spec §3.2 are legal values here and
 * each has its own content schema. Shared fields live in the base schema; the
 * registry selects the matching specialised schema without a large union.
 */
export const STREAM_TYPE = [
  "feature",
  "bug",
  "change",
  "experiment",
  "investigation",
  "refactor",
  "maintenance",
] as const;
export type StreamType = (typeof STREAM_TYPE)[number];
export const streamTypeSchema = z.enum(STREAM_TYPE);

/**
 * A task is a technical unit of work, so unlike a stream it has an
 * `in_review` stage and reaches `done` rather than `completed`.
 */
export const TASK_STATUS = [
  "draft",
  "ready",
  "in_progress",
  "blocked",
  "in_review",
  "done",
  "cancelled",
] as const;
export type TaskStatus = (typeof TASK_STATUS)[number];
export const taskStatusSchema = z.enum(TASK_STATUS);

/** Domain spec §3.3. */
export const TASK_TYPE = [
  "implementation",
  "investigation",
  "migration",
  "testing",
  "review",
  "decision",
] as const;
export type TaskType = (typeof TASK_TYPE)[number];
export const taskTypeSchema = z.enum(TASK_TYPE);

/** Who can carry out a task, independent of who is currently assigned to it. */
export const EXECUTOR_KIND = ["human", "agent", "either"] as const;
export type ExecutorKind = (typeof EXECUTOR_KIND)[number];
export const executorKindSchema = z.enum(EXECUTOR_KIND);

/** Lifecycle of a canonical project Rule. Deprecated Rules remain addressable. */
export const RULE_STATUS = ["draft", "active", "deprecated"] as const;
export type RuleStatus = (typeof RULE_STATUS)[number];
export const ruleStatusSchema = z.enum(RULE_STATUS);

/** Advisory roadmap lifecycle; hard prerequisites remain dependency edges. */
export const MILESTONE_STATUS = ["draft", "planned", "active", "completed", "cancelled"] as const;
export type MilestoneStatus = (typeof MILESTONE_STATUS)[number];
export const milestoneStatusSchema = z.enum(MILESTONE_STATUS);

/** Completion state of one locally identified Milestone exit criterion. */
export const EXIT_CRITERION_STATUS = ["open", "met", "waived"] as const;
export type ExitCriterionStatus = (typeof EXIT_CRITERION_STATUS)[number];
export const exitCriterionStatusSchema = z.enum(EXIT_CRITERION_STATUS);

/**
 * Every entity kind that owns a validated, revisioned document and a generated
 * project-scoped key. `workspace` and `project` remain organisational
 * containers rather than versioned entities.
 *
 * This set deliberately says nothing about hierarchy, moves or dependencies.
 * Rules and milestones are versioned documents, but neither is a work-tree node
 * or a legal dependency endpoint.
 */
export const VERSIONED_ENTITY_TYPE = ["epic", "stream", "task", "milestone", "rule"] as const;
export type VersionedEntityType = (typeof VERSIONED_ENTITY_TYPE)[number];
export const versionedEntityTypeSchema = z.enum(VERSIONED_ENTITY_TYPE);

/** The strict planning hierarchy: Project → Epic → Stream → Task. */
export const HIERARCHY_ENTITY_TYPE = ["epic", "stream", "task"] as const;
export type HierarchyEntityType = (typeof HIERARCHY_ENTITY_TYPE)[number];
export const hierarchyEntityTypeSchema = z.enum(HIERARCHY_ENTITY_TYPE);

/** Entities whose parent may be changed by a move operation. */
export const MOVABLE_ENTITY_TYPE = HIERARCHY_ENTITY_TYPE;
export type MovableEntityType = HierarchyEntityType;
export const movableEntityTypeSchema = hierarchyEntityTypeSchema;

/** The only entity kinds that may participate in a hard `blocked_by` edge. */
export const DEPENDENCY_ENDPOINT_TYPE = ["stream", "task"] as const;
export type DependencyEndpointType = (typeof DEPENDENCY_ENDPOINT_TYPE)[number];
export const dependencyEndpointTypeSchema = z.enum(DEPENDENCY_ENDPOINT_TYPE);

/** Versioned entities that may participate in the relationship graph. */
export const LINKABLE_ENTITY_TYPE = ["epic", "stream", "task", "rule"] as const;
export type LinkableEntityType = (typeof LINKABLE_ENTITY_TYPE)[number];
export const linkableEntityTypeSchema = z.enum(LINKABLE_ENTITY_TYPE);

/**
 * Link relationships, normalised to exactly one direction per pair. The domain
 * spec §5.5 nests `blocked_by` inside a `depends_on` container and §8 names
 * `extends` / `fixes` / `supersedes` / `related_to`; the container is a
 * document-shape detail, so only the relations themselves are stored.
 *
 * `blocks` is deliberately absent: it is the inverse of `blocked_by`, and
 * storing both directions means every cycle check and every read has to
 * reconcile them. Input that says `blocks` is normalised by swapping source
 * and target (the change-set engine, B13, owns that swap).
 */
export const RELATIONSHIP_TYPE = [
  "blocked_by",
  "related_to",
  "extends",
  "fixes",
  "supersedes",
  "derived_from",
  "exception_to",
] as const;
export type RelationshipType = (typeof RELATIONSHIP_TYPE)[number];
export const relationshipTypeSchema = z.enum(RELATIONSHIP_TYPE);
