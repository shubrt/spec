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
 * `test/domain/enums.test.ts` walks the module's exports and enforces the
 * pairing, so a new set added here is covered without editing the test.
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
 * All seven stream types from the domain spec §3.2 are legal values here. Only
 * three of them get a dedicated Zod content schema in the MVP (B7); the other
 * four fall back to the base stream schema, which is why the type union is
 * complete even though the schema registry is not.
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

/**
 * The entity kinds that carry a validated `document`, a `revision` counter and
 * a generated key. `workspace` and `project` are organisational containers
 * (domain spec §3) with no document, so they are not entity types: they never
 * appear in `entity_revision` or as a link endpoint.
 */
export const ENTITY_TYPE = ["epic", "stream", "task"] as const;
export type EntityType = (typeof ENTITY_TYPE)[number];
export const entityTypeSchema = z.enum(ENTITY_TYPE);

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
] as const;
export type RelationshipType = (typeof RELATIONSHIP_TYPE)[number];
export const relationshipTypeSchema = z.enum(RELATIONSHIP_TYPE);
