import { type AnyColumn, type SQL, and, asc, eq, sql } from "drizzle-orm";
import { db } from "../../integration/drizzle/client";
import { executeRows } from "../../integration/drizzle/executeRows";
import { epic } from "../../integration/drizzle/schema/epic";
import { milestone } from "../../integration/drizzle/schema/milestone";
import { project } from "../../integration/drizzle/schema/project";
import { rule } from "../../integration/drizzle/schema/rule";
import { stream } from "../../integration/drizzle/schema/stream";
import { task } from "../../integration/drizzle/schema/task";
import type { WorkspaceScope } from "../auth/workspaceScope";
import {
  VERSIONED_ENTITY_TYPE,
  type HierarchyEntityType,
  type VersionedEntityType,
} from "../enums";
import type { DbExecutor } from "./entity";

/**
 * The compact discovery projection behind `list_context`.
 *
 * It deliberately selects only relational columns. A list is where an agent scans
 * a project, so returning document JSON here would multiply token use by every row
 * and duplicate `get_context`. All five versioned kinds are combined in one
 * statement so pagination is over the complete project catalogue rather than
 * independently limited lists.
 *
 * Adding a project-scoped entity later is one new branch plus its ordering columns;
 * callers and the public row shape do not need another discovery mechanism.
 */

export type ListContextProjectRow = {
  readonly name: string;
};

export type ListContextEntityRow = {
  readonly project: string;
  readonly key: string;
  readonly title: string;
  readonly entity: VersionedEntityType;
  readonly subtype: string | null;
  readonly status: string;
  readonly revision: number;
  readonly parentKey: string | null;
  readonly roadmapOrder: number | null;
  readonly milestoneKey: string | null;
  readonly roadmapRank: number | null;
};

export type CompactEntityReference = {
  readonly id: string;
  readonly key: string;
  readonly entity: VersionedEntityType;
  readonly projectId: string;
  readonly project: string;
};

export type ListContextParentEntity = Exclude<HierarchyEntityType, "task">;

export type ListContextEntityOptions = {
  readonly projectId?: string;
  readonly entity?: VersionedEntityType;
  readonly status?: string;
  readonly parent?: {
    readonly entity: ListContextParentEntity;
    readonly id: string;
  };
  /** Advisory roadmap filter, independent of hierarchy parentage. */
  readonly milestoneId?: string;
  readonly limit: number;
  readonly offset: number;
};

export type ListContextProjectOptions = {
  readonly limit: number;
  readonly offset: number;
};

async function listProjects(
  scope: WorkspaceScope,
  options: ListContextProjectOptions,
  executor: DbExecutor = db,
): Promise<readonly ListContextProjectRow[]> {
  return await executor
    .select({ name: project.name })
    .from(project)
    .where(eq(project.workspaceId, scope))
    .orderBy(asc(project.name), asc(project.id))
    .limit(options.limit)
    .offset(options.offset);
}

const optionalFilter = (column: AnyColumn, value: string | undefined): SQL =>
  value === undefined ? sql`` : sql` and ${column} = ${value}`;

const parentAllows = (options: ListContextEntityOptions, entity: VersionedEntityType): boolean => {
  if (options.entity !== undefined && options.entity !== entity) {
    return false;
  }
  if (options.milestoneId !== undefined && entity !== "stream" && entity !== "task") {
    return false;
  }
  if (options.parent === undefined) {
    return true;
  }
  return (
    (options.parent.entity === "epic" && entity === "stream") ||
    (options.parent.entity === "stream" && entity === "task")
  );
};

const epicBranch = (scope: WorkspaceScope, options: ListContextEntityOptions): SQL => sql`
  select ${project.name} as project,
         ${project.id} as project_id,
         ${epic.key} as key,
         ${epic.title} as title,
         'epic'::text as entity,
         null::text as subtype,
         ${epic.status} as status,
         ${epic.revision} as revision,
         null::text as parent_key,
         null::integer as roadmap_order,
         null::text as milestone_key,
         null::integer as roadmap_rank,
         0::integer as family_order,
         ${epic.createdAt} as epic_created_at,
         ${epic.key} as epic_sort_key,
         null::timestamptz as stream_created_at,
         ''::text as stream_sort_key,
         null::timestamptz as task_created_at,
         ''::text as task_sort_key,
         null::integer as standalone_order,
         null::timestamptz as standalone_created_at,
         ''::text as standalone_sort_key
    from ${epic}
    join ${project}
      on ${project.id} = ${epic.projectId}
     and ${project.workspaceId} = ${scope}
   where ${epic.workspaceId} = ${scope}
     ${optionalFilter(epic.projectId, options.projectId)}
     ${optionalFilter(epic.status, options.status)}`;

const streamBranch = (scope: WorkspaceScope, options: ListContextEntityOptions): SQL => sql`
  select ${project.name} as project,
         ${project.id} as project_id,
         ${stream.key} as key,
         ${stream.title} as title,
         'stream'::text as entity,
         ${stream.streamType} as subtype,
         ${stream.status} as status,
         ${stream.revision} as revision,
         ${epic.key} as parent_key,
         ${milestone.roadmapOrder} as roadmap_order,
         ${milestone.key} as milestone_key,
         ${stream.roadmapRank} as roadmap_rank,
         0::integer as family_order,
         ${epic.createdAt} as epic_created_at,
         ${epic.key} as epic_sort_key,
         ${stream.createdAt} as stream_created_at,
         ${stream.key} as stream_sort_key,
         null::timestamptz as task_created_at,
         ''::text as task_sort_key,
         null::integer as standalone_order,
         null::timestamptz as standalone_created_at,
         ''::text as standalone_sort_key
    from ${stream}
    join ${epic}
      on ${epic.id} = ${stream.epicId}
     and ${epic.workspaceId} = ${scope}
    join ${project}
      on ${project.id} = ${stream.projectId}
     and ${project.workspaceId} = ${scope}
    left join ${milestone}
      on ${milestone.id} = ${stream.milestoneId}
     and ${milestone.workspaceId} = ${scope}
     and ${milestone.projectId} = ${stream.projectId}
   where ${stream.workspaceId} = ${scope}
     ${optionalFilter(stream.projectId, options.projectId)}
     ${optionalFilter(stream.status, options.status)}
     ${options.parent?.entity === "epic" ? sql`and ${stream.epicId} = ${options.parent.id}` : sql``}
     ${options.milestoneId === undefined ? sql`` : sql`and ${stream.milestoneId} = ${options.milestoneId}`}`;

const taskBranch = (scope: WorkspaceScope, options: ListContextEntityOptions): SQL => sql`
  select ${project.name} as project,
         ${project.id} as project_id,
         ${task.key} as key,
         ${task.title} as title,
         'task'::text as entity,
         ${task.taskType} as subtype,
         ${task.status} as status,
         ${task.revision} as revision,
         ${stream.key} as parent_key,
         ${milestone.roadmapOrder} as roadmap_order,
         ${milestone.key} as milestone_key,
         ${stream.roadmapRank} as roadmap_rank,
         0::integer as family_order,
         ${epic.createdAt} as epic_created_at,
         ${epic.key} as epic_sort_key,
         ${stream.createdAt} as stream_created_at,
         ${stream.key} as stream_sort_key,
         ${task.createdAt} as task_created_at,
         ${task.key} as task_sort_key,
         null::integer as standalone_order,
         null::timestamptz as standalone_created_at,
         ''::text as standalone_sort_key
    from ${task}
    join ${stream}
      on ${stream.id} = ${task.streamId}
     and ${stream.workspaceId} = ${scope}
    join ${epic}
      on ${epic.id} = ${stream.epicId}
     and ${epic.workspaceId} = ${scope}
    join ${project}
      on ${project.id} = ${task.projectId}
     and ${project.workspaceId} = ${scope}
    left join ${milestone}
      on ${milestone.id} = ${stream.milestoneId}
     and ${milestone.workspaceId} = ${scope}
     and ${milestone.projectId} = ${stream.projectId}
   where ${task.workspaceId} = ${scope}
     ${optionalFilter(task.projectId, options.projectId)}
     ${optionalFilter(task.status, options.status)}
     ${options.parent?.entity === "stream" ? sql`and ${task.streamId} = ${options.parent.id}` : sql``}
     ${options.milestoneId === undefined ? sql`` : sql`and ${stream.milestoneId} = ${options.milestoneId}`}`;

const milestoneBranch = (scope: WorkspaceScope, options: ListContextEntityOptions): SQL => sql`
  select ${project.name} as project,
         ${project.id} as project_id,
         ${milestone.key} as key,
         ${milestone.title} as title,
         'milestone'::text as entity,
         null::text as subtype,
         ${milestone.status} as status,
         ${milestone.revision} as revision,
         null::text as parent_key,
         ${milestone.roadmapOrder} as roadmap_order,
         null::text as milestone_key,
         null::integer as roadmap_rank,
         1::integer as family_order,
         null::timestamptz as epic_created_at,
         ''::text as epic_sort_key,
         null::timestamptz as stream_created_at,
         ''::text as stream_sort_key,
         null::timestamptz as task_created_at,
         ''::text as task_sort_key,
         ${milestone.roadmapOrder} as standalone_order,
         ${milestone.createdAt} as standalone_created_at,
         ${milestone.key} as standalone_sort_key
    from ${milestone}
    join ${project}
      on ${project.id} = ${milestone.projectId}
     and ${project.workspaceId} = ${scope}
   where ${milestone.workspaceId} = ${scope}
     ${optionalFilter(milestone.projectId, options.projectId)}
     ${optionalFilter(milestone.status, options.status)}`;

const ruleBranch = (scope: WorkspaceScope, options: ListContextEntityOptions): SQL => sql`
  select ${project.name} as project,
         ${project.id} as project_id,
         ${rule.key} as key,
         ${rule.title} as title,
         'rule'::text as entity,
         null::text as subtype,
         ${rule.status} as status,
         ${rule.revision} as revision,
         null::text as parent_key,
         null::integer as roadmap_order,
         null::text as milestone_key,
         null::integer as roadmap_rank,
         2::integer as family_order,
         null::timestamptz as epic_created_at,
         ''::text as epic_sort_key,
         null::timestamptz as stream_created_at,
         ''::text as stream_sort_key,
         null::timestamptz as task_created_at,
         ''::text as task_sort_key,
         0::integer as standalone_order,
         ${rule.createdAt} as standalone_created_at,
         ${rule.key} as standalone_sort_key
    from ${rule}
    join ${project}
      on ${project.id} = ${rule.projectId}
     and ${project.workspaceId} = ${scope}
   where ${rule.workspaceId} = ${scope}
     ${optionalFilter(rule.projectId, options.projectId)}
     ${optionalFilter(rule.status, options.status)}`;

const entityBranches = (
  scope: WorkspaceScope,
  options: ListContextEntityOptions,
): readonly SQL[] => {
  const branches: SQL[] = [];
  if (parentAllows(options, "epic")) branches.push(epicBranch(scope, options));
  if (parentAllows(options, "stream")) branches.push(streamBranch(scope, options));
  if (parentAllows(options, "task")) branches.push(taskBranch(scope, options));
  if (parentAllows(options, "milestone")) branches.push(milestoneBranch(scope, options));
  if (parentAllows(options, "rule")) branches.push(ruleBranch(scope, options));
  return branches;
};

/**
 * One ordered statement for the whole visible tree.
 *
 * The nullable child timestamps are intentional ordering sentinels: the epic has
 * no stream timestamp and therefore sorts before its streams; a stream has no task
 * timestamp and sorts before its tasks. The key breaks same-transaction timestamp
 * ties and keeps repeated pages deterministic.
 */
export function listContextEntitiesStatement(
  scope: WorkspaceScope,
  options: ListContextEntityOptions,
): SQL | null {
  const branches = entityBranches(scope, options);
  if (branches.length === 0) {
    return null;
  }
  const entityOrder =
    options.milestoneId === undefined
      ? sql`listed.family_order,
            listed.epic_created_at, listed.epic_sort_key,
            listed.stream_created_at nulls first, listed.stream_sort_key,
            listed.task_created_at nulls first, listed.task_sort_key,
            listed.standalone_order, listed.standalone_created_at,
            listed.standalone_sort_key, listed.entity`
      : sql`listed.roadmap_rank nulls last,
            listed.stream_created_at, listed.stream_sort_key,
            listed.task_created_at nulls first, listed.task_sort_key,
            listed.entity`;
  return sql`
    with listed as (
      ${sql.join([...branches], sql` union all `)}
    )
    select listed.project, listed.key, listed.title, listed.entity, listed.subtype,
           listed.status, listed.revision, listed.parent_key, listed.roadmap_order,
           listed.milestone_key, listed.roadmap_rank
      from listed
     order by lower(listed.project), listed.project, listed.project_id,
              ${entityOrder}
     limit ${options.limit}
    offset ${options.offset}`;
}

type RawListContextEntityRow = {
  readonly project: string;
  readonly key: string;
  readonly title: string;
  readonly entity: unknown;
  readonly subtype: string | null;
  readonly status: string;
  readonly revision: number;
  readonly parent_key: string | null;
  readonly roadmap_order: number | null;
  readonly milestone_key: string | null;
  readonly roadmap_rank: number | null;
};

const isEntityType = (value: unknown): value is VersionedEntityType =>
  VERSIONED_ENTITY_TYPE.some((candidate) => candidate === value);

const toEntityRow = (row: RawListContextEntityRow): ListContextEntityRow => {
  if (!isEntityType(row.entity)) {
    throw new Error(`list_context returned an unknown entity kind: ${JSON.stringify(row.entity)}`);
  }
  return {
    project: row.project,
    key: row.key,
    title: row.title,
    entity: row.entity,
    subtype: row.subtype ?? null,
    status: row.status,
    revision: row.revision,
    parentKey: row.parent_key ?? null,
    roadmapOrder: row.roadmap_order ?? null,
    milestoneKey: row.milestone_key ?? null,
    roadmapRank: row.roadmap_rank ?? null,
  };
};

async function listEntities(
  scope: WorkspaceScope,
  options: ListContextEntityOptions,
  executor: DbExecutor = db,
): Promise<readonly ListContextEntityRow[]> {
  const statement = listContextEntitiesStatement(scope, options);
  if (statement === null) {
    return [];
  }
  const rows = await executeRows<RawListContextEntityRow>(executor, statement);
  return rows.map(toEntityRow);
}

type CompactReferenceRow = Omit<CompactEntityReference, "entity">;

async function findByKey(
  scope: WorkspaceScope,
  input: {
    readonly entity: VersionedEntityType;
    readonly key: string;
    readonly projectId?: string;
  },
  executor: DbExecutor = db,
): Promise<readonly CompactEntityReference[]> {
  const projectFilter = input.projectId;
  switch (input.entity) {
    case "epic": {
      const rows: CompactReferenceRow[] = await executor
        .select({
          id: epic.id,
          key: epic.key,
          projectId: epic.projectId,
          project: project.name,
        })
        .from(epic)
        .innerJoin(project, and(eq(project.id, epic.projectId), eq(project.workspaceId, scope)))
        .where(
          and(
            eq(epic.workspaceId, scope),
            eq(epic.key, input.key),
            projectFilter === undefined ? undefined : eq(epic.projectId, projectFilter),
          ),
        )
        .orderBy(asc(project.name));
      return rows.map((row) => ({ ...row, entity: "epic" }));
    }
    case "stream": {
      const rows: CompactReferenceRow[] = await executor
        .select({
          id: stream.id,
          key: stream.key,
          projectId: stream.projectId,
          project: project.name,
        })
        .from(stream)
        .innerJoin(project, and(eq(project.id, stream.projectId), eq(project.workspaceId, scope)))
        .where(
          and(
            eq(stream.workspaceId, scope),
            eq(stream.key, input.key),
            projectFilter === undefined ? undefined : eq(stream.projectId, projectFilter),
          ),
        )
        .orderBy(asc(project.name));
      return rows.map((row) => ({ ...row, entity: "stream" }));
    }
    case "task": {
      const rows: CompactReferenceRow[] = await executor
        .select({
          id: task.id,
          key: task.key,
          projectId: task.projectId,
          project: project.name,
        })
        .from(task)
        .innerJoin(project, and(eq(project.id, task.projectId), eq(project.workspaceId, scope)))
        .where(
          and(
            eq(task.workspaceId, scope),
            eq(task.key, input.key),
            projectFilter === undefined ? undefined : eq(task.projectId, projectFilter),
          ),
        )
        .orderBy(asc(project.name));
      return rows.map((row) => ({ ...row, entity: "task" }));
    }
    case "milestone": {
      const rows: CompactReferenceRow[] = await executor
        .select({
          id: milestone.id,
          key: milestone.key,
          projectId: milestone.projectId,
          project: project.name,
        })
        .from(milestone)
        .innerJoin(
          project,
          and(eq(project.id, milestone.projectId), eq(project.workspaceId, scope)),
        )
        .where(
          and(
            eq(milestone.workspaceId, scope),
            eq(milestone.key, input.key),
            projectFilter === undefined ? undefined : eq(milestone.projectId, projectFilter),
          ),
        )
        .orderBy(asc(project.name));
      return rows.map((row) => ({ ...row, entity: "milestone" }));
    }
    case "rule": {
      const rows: CompactReferenceRow[] = await executor
        .select({
          id: rule.id,
          key: rule.key,
          projectId: rule.projectId,
          project: project.name,
        })
        .from(rule)
        .innerJoin(project, and(eq(project.id, rule.projectId), eq(project.workspaceId, scope)))
        .where(
          and(
            eq(rule.workspaceId, scope),
            eq(rule.key, input.key),
            projectFilter === undefined ? undefined : eq(rule.projectId, projectFilter),
          ),
        )
        .orderBy(asc(project.name));
      return rows.map((row) => ({ ...row, entity: "rule" }));
    }
  }
}

export const listContextRepository = { listProjects, listEntities, findByKey };
