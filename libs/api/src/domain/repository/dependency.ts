import { type SQL, sql } from "drizzle-orm";
import { db } from "../../integration/drizzle/client";
import { entityLink } from "../../integration/drizzle/schema/entityLink";
import { epic } from "../../integration/drizzle/schema/epic";
import { stream } from "../../integration/drizzle/schema/stream";
import { task } from "../../integration/drizzle/schema/task";
import type { WorkspaceScope } from "../auth/workspaceScope";
import { ENTITY_TYPE, type EntityType } from "../enums";
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
 * words an agent can act on". Keeping it here also keeps it inside
 * `src/domain/repository/`, which is the directory
 * `test/domain/repository/scope.test.ts` reflects over: a tenant-filtered query
 * living anywhere else would silently escape that guard.
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
 * dependency; the three `LEFT JOIN`s here make it one round trip per entity. That
 * is the constraint `test/domain/context/bundle.test.ts` counts.
 */

export type DependencyRow = {
  /** `blocked_by` — the other entity blocks this one. `blocks` — the reverse. */
  readonly direction: "blocked_by" | "blocks";
  readonly entity: EntityType;
  readonly key: string;
  readonly title: string;
  readonly status: string;
  readonly reason: string | null;
};

export type DependencyEndpoint = {
  readonly entity: EntityType;
  readonly id: string;
};

const BLOCKED_BY = "blocked_by";

const isEntityType = (value: unknown): value is EntityType =>
  ENTITY_TYPE.some((candidate) => candidate === value);

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
  if (!isEntityType(row.entity)) {
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
         coalesce(${epic.key}, ${stream.key}, ${task.key}) as key,
         coalesce(${epic.title}, ${stream.title}, ${task.title}) as title,
         coalesce(${epic.status}, ${stream.status}, ${task.status}) as status,
         edge.reason as reason
    from edge
    left join ${epic}
      on edge.other_type = 'epic' and ${epic.id} = edge.other_id and ${epic.workspaceId} = ${scope}
    left join ${stream}
      on edge.other_type = 'stream' and ${stream.id} = edge.other_id and ${stream.workspaceId} = ${scope}
    left join ${task}
      on edge.other_type = 'task' and ${task.id} = edge.other_id and ${task.workspaceId} = ${scope}
   where coalesce(${epic.id}, ${stream.id}, ${task.id}) is not null
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
  const rows = (await executor.execute(
    dependencyStatement(scope, endpoint),
  )) as unknown as RawDependencyRow[];
  return [...rows].map(toDependencyRow);
}

export const dependencyRepository = { forEntity };
