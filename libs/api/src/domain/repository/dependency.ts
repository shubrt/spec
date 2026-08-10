import { type SQL, and, eq, inArray, ne, sql } from "drizzle-orm";
import { db } from "../../integration/drizzle/client";
import { executeRows } from "../../integration/drizzle/executeRows";
import { entityLink } from "../../integration/drizzle/schema/entityLink";
import { stream } from "../../integration/drizzle/schema/stream";
import { task } from "../../integration/drizzle/schema/task";
import type { WorkspaceScope } from "../auth/workspaceScope";
import {
  DEPENDENCY_ENDPOINT_TYPE,
  type DependencyEndpointType,
  type StreamStatus,
  type TaskStatus,
} from "../enums";
import type { DbExecutor } from "./entity";

/**
 * One entity's dependencies, with the other end of each edge already named
 * (plan task B16).
 *
 * ## Why this is not a method on `entityLinkRepository`
 *
 * That repository owns writing edges and handing the raw graph to the cycle check;
 * this is a *read projection* for the context bundle, and it answers a different
 * question — "what is this one entity waiting on, and what is waiting on it, in
 * words an agent can act on". Keeping it in `src/domain/repository/` also keeps
 * the tenant-scoping convention visible alongside every other persisted read.
 *
 * ## Both directions out of one stored direction
 *
 * `entity_link` stores only `blocked_by` — `A blocks B` is written as
 * `B blocked_by A`, normalised once in `entityLinkRepository.link`. So "what blocks
 * me" is the rows where I am the *source*, and "what I block" is the rows where I
 * am the *target*. The `edge` CTE turns those two reads into one column,
 * `direction`, so the three endpoint joins below are written once instead of twice.
 *
 * ## One query, whatever the number of edges
 *
 * The endpoints are polymorphic `(type, id)` pairs with no foreign key, so naming
 * them means looking in three tables. Doing that per edge is one round trip per
 * dependency; the three `LEFT JOIN`s here make it one round trip per entity.
 */

export type DependencyRow = {
  /** `blocked_by` — the other entity blocks this one. `blocks` — the reverse. */
  readonly direction: "blocked_by" | "blocks";
  readonly entity: DependencyEndpointType;
  readonly key: string;
  readonly title: string;
  readonly status: string;
  readonly reason: string | null;
};

export type DependencyEndpoint = {
  readonly entity: DependencyEndpointType;
  readonly id: string;
};

const BLOCKED_BY = "blocked_by";

const isDependencyEndpointType = (value: unknown): value is DependencyEndpointType =>
  DEPENDENCY_ENDPOINT_TYPE.some((candidate) => candidate === value);

/**
 * One row as the driver hands it back. The statement below is in this file, so every
 * column's type is known except `entity`, which comes from `entity_link`'s
 * polymorphic `*_type` column and is therefore the one field checked at runtime.
 */
type RawDependencyRow = {
  readonly direction: string;
  readonly entity: unknown;
  readonly key: string;
  readonly title: string;
  readonly status: string;
  readonly reason: string | null;
};

const toDependencyRow = (row: RawDependencyRow): DependencyRow => {
  if (!isDependencyEndpointType(row.entity)) {
    throw new Error(
      `dependency lookup returned an unknown entity kind: ${JSON.stringify(row.entity)}`,
    );
  }
  return {
    direction: row.direction === BLOCKED_BY ? BLOCKED_BY : "blocks",
    entity: row.entity,
    key: row.key,
    title: row.title,
    status: row.status,
    reason: row.reason ?? null,
  };
};

/**
 * The `where coalesce(…) is not null` at the end drops edges whose other end no
 * longer exists. `entity_link` carries no foreign key on its polymorphic endpoints,
 * so deleting an entity leaves its edges behind and the change-set engine owns that
 * cleanup; a read path must not answer "blocked by" with a row it cannot name.
 */
const dependencyStatement = (scope: WorkspaceScope, endpoint: DependencyEndpoint): SQL => sql`
  with edge as (
    select 'blocked_by'::text as direction,
           ${entityLink.targetType} as other_type, ${entityLink.targetId} as other_id,
           ${entityLink.reason} as reason, ${entityLink.createdAt} as created_at, ${entityLink.id} as id
      from ${entityLink}
     where ${entityLink.workspaceId} = ${scope}
       and ${entityLink.relationshipType} = ${BLOCKED_BY}
       and ${entityLink.sourceType} = ${endpoint.entity}
       and ${entityLink.sourceId} = ${endpoint.id}
    union all
    select 'blocks'::text,
           ${entityLink.sourceType}, ${entityLink.sourceId},
           ${entityLink.reason}, ${entityLink.createdAt}, ${entityLink.id}
      from ${entityLink}
     where ${entityLink.workspaceId} = ${scope}
       and ${entityLink.relationshipType} = ${BLOCKED_BY}
       and ${entityLink.targetType} = ${endpoint.entity}
       and ${entityLink.targetId} = ${endpoint.id}
  )
  select edge.direction as direction,
         edge.other_type as entity,
         coalesce(${stream.key}, ${task.key}) as key,
         coalesce(${stream.title}, ${task.title}) as title,
         coalesce(${stream.status}, ${task.status}) as status,
         edge.reason as reason
    from edge
    left join ${stream}
      on edge.other_type = 'stream' and ${stream.id} = edge.other_id and ${stream.workspaceId} = ${scope}
    left join ${task}
      on edge.other_type = 'task' and ${task.id} = edge.other_id and ${task.workspaceId} = ${scope}
   where coalesce(${stream.id}, ${task.id}) is not null
   order by edge.direction, edge.created_at, edge.id`;

/**
 * Every `blocked_by` edge touching `endpoint`, in either direction, inside `scope`.
 *
 * Only `blocked_by` — the other relationship types (`related_to`, `extends`,
 * `fixes`, `supersedes`) are cross-references, not ordering constraints, and the
 * §7 bundle asks for the entity's *dependencies*.
 */
async function forEntity(
  scope: WorkspaceScope,
  endpoint: DependencyEndpoint,
  executor: DbExecutor = db,
): Promise<readonly DependencyRow[]> {
  const rows = await executeRows<RawDependencyRow>(executor, dependencyStatement(scope, endpoint));
  return rows.map(toDependencyRow);
}

/**
 * Which candidate work entities are still blocked by an unfinished entity at
 * the same level.
 *
 * `get_next_work` asks once for every candidate Stream and once for every
 * candidate Task, never once per item. `entity_link` stores only `blocked_by`,
 * source-is-blocked, so "what blocks me" is the rows where I am the source — and
 * the blocker's own status has to be read, which is the join.
 *
 * The tenant filter is on **both** tables. The edge table's filter alone would let
 * a blocker row from another workspace decide whether this workspace's task is
 * workable, and a foreign blocker that happened not to be `done` would silently
 * hide work.
 *
 * Source and target type are both constrained to `input.entity`. A Task can only
 * wait on a Task (`done` clears it); a Stream can only wait on a Stream
 * (`completed` clears it). `cancelled` is intentionally not a completion state,
 * so it continues to block until the relationship is consciously removed or
 * replaced.
 */
async function blockedIds(
  scope: WorkspaceScope,
  input: { readonly entity: DependencyEndpointType; readonly ids: readonly string[] },
  executor: DbExecutor = db,
): Promise<ReadonlySet<string>> {
  if (input.ids.length === 0) {
    return new Set();
  }
  const endpointFilter = and(
    eq(entityLink.workspaceId, scope),
    eq(entityLink.relationshipType, BLOCKED_BY),
    eq(entityLink.sourceType, input.entity),
    inArray(entityLink.sourceId, [...input.ids]),
    eq(entityLink.targetType, input.entity),
  );
  const rows =
    input.entity === "task"
      ? await executor
          .selectDistinct({ id: entityLink.sourceId })
          .from(entityLink)
          .innerJoin(
            task,
            and(
              eq(task.id, entityLink.targetId),
              eq(task.workspaceId, scope),
              ne(task.status, TASK_COMPLETED),
            ),
          )
          .where(endpointFilter)
      : await executor
          .selectDistinct({ id: entityLink.sourceId })
          .from(entityLink)
          .innerJoin(
            stream,
            and(
              eq(stream.id, entityLink.targetId),
              eq(stream.workspaceId, scope),
              ne(stream.status, STREAM_COMPLETED),
            ),
          )
          .where(endpointFilter);
  return new Set(rows.map((row) => row.id));
}

/** The only statuses that satisfy a hard dependency at their respective level. */
const TASK_COMPLETED: TaskStatus = "done";
const STREAM_COMPLETED: StreamStatus = "completed";

export const dependencyRepository = { forEntity, blockedIds };
