import { type SQL, sql } from "drizzle-orm";
import { db } from "../../integration/drizzle/client";
import { executeRows } from "../../integration/drizzle/executeRows";
import { entityLink } from "../../integration/drizzle/schema/entityLink";
import { epic } from "../../integration/drizzle/schema/epic";
import { rule } from "../../integration/drizzle/schema/rule";
import { stream } from "../../integration/drizzle/schema/stream";
import { task } from "../../integration/drizzle/schema/task";
import type { WorkspaceScope } from "../auth/workspaceScope";
import {
  LINKABLE_ENTITY_TYPE,
  RELATIONSHIP_TYPE,
  type LinkableEntityType,
  type RelationshipType,
} from "../enums";
import type { DbExecutor } from "./entity";

export type EntityRelation = {
  readonly direction: "outgoing" | "incoming";
  readonly relationship: RelationshipType;
  readonly entity: LinkableEntityType;
  readonly key: string;
  readonly title: string;
  readonly status: string;
  readonly reason: string | null;
};

type RawEntityRelation = {
  readonly direction: unknown;
  readonly relationship: unknown;
  readonly entity: unknown;
  readonly key: string;
  readonly title: string;
  readonly status: string;
  readonly reason: string | null;
};

const isRelationship = (value: unknown): value is RelationshipType =>
  RELATIONSHIP_TYPE.some((candidate) => candidate === value);

const isLinkableEntity = (value: unknown): value is LinkableEntityType =>
  LINKABLE_ENTITY_TYPE.some((candidate) => candidate === value);

const relationStatement = (
  scope: WorkspaceScope,
  input: { readonly projectId: string; readonly entity: LinkableEntityType; readonly id: string },
): SQL => sql`
  with edge as (
    select 'outgoing'::text as direction,
           ${entityLink.relationshipType} as relationship,
           ${entityLink.targetType} as other_type,
           ${entityLink.targetId} as other_id,
           ${entityLink.reason} as reason,
           ${entityLink.createdAt} as created_at,
           ${entityLink.id} as id
      from ${entityLink}
     where ${entityLink.workspaceId} = ${scope}
       and ${entityLink.projectId} = ${input.projectId}
       and ${entityLink.sourceType} = ${input.entity}
       and ${entityLink.sourceId} = ${input.id}
       and ${entityLink.relationshipType} <> 'blocked_by'
    union all
    select 'incoming'::text,
           ${entityLink.relationshipType},
           ${entityLink.sourceType},
           ${entityLink.sourceId},
           ${entityLink.reason},
           ${entityLink.createdAt},
           ${entityLink.id}
      from ${entityLink}
     where ${entityLink.workspaceId} = ${scope}
       and ${entityLink.projectId} = ${input.projectId}
       and ${entityLink.targetType} = ${input.entity}
       and ${entityLink.targetId} = ${input.id}
       and ${entityLink.relationshipType} <> 'blocked_by'
  )
  select edge.direction, edge.relationship, edge.other_type as entity,
         coalesce(${epic.key}, ${stream.key}, ${task.key}, ${rule.key}) as key,
         coalesce(${epic.title}, ${stream.title}, ${task.title}, ${rule.title}) as title,
         coalesce(${epic.status}, ${stream.status}, ${task.status}, ${rule.status}) as status,
         edge.reason
    from edge
    left join ${epic}
      on edge.other_type = 'epic' and ${epic.id} = edge.other_id and ${epic.workspaceId} = ${scope}
    left join ${stream}
      on edge.other_type = 'stream' and ${stream.id} = edge.other_id and ${stream.workspaceId} = ${scope}
    left join ${task}
      on edge.other_type = 'task' and ${task.id} = edge.other_id and ${task.workspaceId} = ${scope}
    left join ${rule}
      on edge.other_type = 'rule' and ${rule.id} = edge.other_id and ${rule.workspaceId} = ${scope}
   where coalesce(${epic.id}, ${stream.id}, ${task.id}, ${rule.id}) is not null
   order by edge.direction, edge.relationship, edge.created_at, edge.id`;

/** Every named incoming and outgoing soft relation in one fixed query. */
async function forEntity(
  scope: WorkspaceScope,
  input: { readonly projectId: string; readonly entity: LinkableEntityType; readonly id: string },
  executor: DbExecutor = db,
): Promise<EntityRelation[]> {
  const rows = await executeRows<RawEntityRelation>(executor, relationStatement(scope, input));
  return rows.map((row) => {
    if (
      (row.direction !== "outgoing" && row.direction !== "incoming") ||
      !isRelationship(row.relationship) ||
      !isLinkableEntity(row.entity)
    ) {
      throw new Error("Relation query returned an invalid discriminator.");
    }
    return {
      direction: row.direction,
      relationship: row.relationship,
      entity: row.entity,
      key: row.key,
      title: row.title,
      status: row.status,
      reason: row.reason ?? null,
    };
  });
}

export const relationRepository = { forEntity };
