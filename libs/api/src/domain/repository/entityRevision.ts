import { sql } from "drizzle-orm";
import { db } from "../../integration/drizzle/client";
import { executeRows } from "../../integration/drizzle/executeRows";
import { entityRevisionSummary } from "../../integration/drizzle/schema/entityRevisionSummary";
import type { WorkspaceScope } from "../auth/workspaceScope";
import type { VersionedEntityType } from "../enums";
import type { RevisionFilter, RevisionKind, SectionDelta } from "../service/revisionLog";
import type { DbExecutor } from "./entity";

/**
 * The queryable revision-history projection.
 *
 * Full immutable documents stay in `entity_revision` for exact historic reads.
 * Its insert trigger writes the final adjacent-revision classification to
 * `entity_revision_summary` in the same transaction. History paging therefore
 * selects compact rows directly: no snapshot JSON and no request-time diff or
 * window over every document in the project.
 */

export type RevisionSummaryEntryRow = {
  readonly entityType: VersionedEntityType;
  readonly entityKey: string;
  readonly title: string;
  readonly revision: number;
  readonly kind: RevisionKind;
  readonly status: string;
  readonly statusChanged: boolean;
  readonly sectionDeltas: readonly SectionDelta[];
  readonly changedBy: string;
  readonly changeReason: string | null;
  readonly createdAt: Date;
};

type RevisionSummaryMetadataRow = {
  readonly total: number;
  readonly actors: unknown;
  readonly reasonCount: number;
  readonly earliest: string | null;
  readonly latest: string | null;
};

export type RevisionSummaryQueryRow = RevisionSummaryMetadataRow &
  (
    | RevisionSummaryEntryRow
    | {
        readonly entityType: null;
        readonly entityKey: null;
        readonly title: null;
        readonly revision: null;
        readonly kind: null;
        readonly status: null;
        readonly statusChanged: null;
        readonly sectionDeltas: null;
        readonly changedBy: null;
        readonly changeReason: null;
        readonly createdAt: null;
      }
  );

type RawRevisionSummaryQueryRow = {
  readonly entity_type: VersionedEntityType | null;
  readonly entity_key: string | null;
  readonly title: string | null;
  readonly revision: number | null;
  readonly kind: RevisionKind | null;
  readonly status: string | null;
  readonly status_changed: boolean | null;
  readonly section_deltas: readonly SectionDelta[] | null;
  readonly changed_by: string | null;
  readonly change_reason: string | null;
  readonly created_at: Date | string | null;
  readonly total: number;
  readonly actors: unknown;
  readonly reason_count: number;
  readonly earliest: string | null;
  readonly latest: string | null;
};

const optionalFilter = (condition: ReturnType<typeof sql>, present: boolean) =>
  present ? condition : sql``;

const filters = (
  scope: WorkspaceScope,
  projectId: string,
  filter: RevisionFilter,
): ReturnType<typeof sql> => sql`
  ${entityRevisionSummary.workspaceId} = ${scope}
  and ${entityRevisionSummary.projectId} = ${projectId}
  ${optionalFilter(
    sql`and (${entityRevisionSummary.createdAt} at time zone 'UTC')::date::text >= ${filter.from}`,
    filter.from !== undefined,
  )}
  ${optionalFilter(
    sql`and (${entityRevisionSummary.createdAt} at time zone 'UTC')::date::text <= ${filter.to}`,
    filter.to !== undefined,
  )}
  ${optionalFilter(
    sql`and ${entityRevisionSummary.entityType} = ${filter.entityType}`,
    filter.entityType !== undefined,
  )}
  ${optionalFilter(
    sql`and ${entityRevisionSummary.kind} = ${filter.kind}`,
    filter.kind !== undefined,
  )}
  ${optionalFilter(
    sql`and ${entityRevisionSummary.changedBy} = ${filter.actor}`,
    filter.actor !== undefined,
  )}
  ${optionalFilter(
    sql`and ${entityRevisionSummary.entityKey} = ${filter.entityKey}`,
    filter.entityKey !== undefined,
  )}`;

/**
 * The exact bounded history statement, exported so an operator can `EXPLAIN`
 * the production query rather than maintaining a hand-copied approximation.
 *
 * `page` is deliberately separate from the materialized aggregate input: it can
 * walk the project-leading history index in display order and stop at the page
 * boundary. Totals and filter controls still inspect all matching compact rows,
 * but never a snapshot; the database returns at most `limit` revision entries.
 */
export function revisionPageStatement(
  scope: WorkspaceScope,
  projectId: string,
  filter: RevisionFilter,
): ReturnType<typeof sql> {
  const where = filters(scope, projectId, filter);
  return sql`
    with filtered as materialized (
      select
        ${entityRevisionSummary.changedBy} as changed_by,
        ${entityRevisionSummary.changeReason} as change_reason,
        ${entityRevisionSummary.createdAt} as created_at
      from ${entityRevisionSummary}
      where ${where}
    ), page as (
      select
        ${entityRevisionSummary.entityType} as entity_type,
        ${entityRevisionSummary.entityKey} as entity_key,
        ${entityRevisionSummary.title} as title,
        ${entityRevisionSummary.revision} as revision,
        ${entityRevisionSummary.kind} as kind,
        ${entityRevisionSummary.status} as status,
        ${entityRevisionSummary.statusChanged} as status_changed,
        ${entityRevisionSummary.sectionDeltas} as section_deltas,
        ${entityRevisionSummary.changedBy} as changed_by,
        ${entityRevisionSummary.changeReason} as change_reason,
        ${entityRevisionSummary.createdAt} as created_at
      from ${entityRevisionSummary}
      where ${where}
      order by ${entityRevisionSummary.createdAt} desc nulls last,
               ${entityRevisionSummary.revision} desc nulls last,
               ${entityRevisionSummary.entityKey} asc
      limit ${filter.limit}
      offset ${filter.offset}
    ), actor_counts as (
      select
        changed_by as actor,
        count(*)::integer as entry_count,
        max(created_at) as latest_activity
      from filtered
      group by changed_by
    ), filter_summary as (
      select
        count(*)::integer as total,
        count(distinct nullif(change_reason, ''))::integer as reason_count,
        coalesce(
          (
            select jsonb_agg(
              jsonb_build_object('actor', actor, 'count', entry_count)
              order by entry_count desc, latest_activity desc, actor asc
            )
            from actor_counts
          ),
          '[]'::jsonb
        ) as actors
      from filtered
    ), log_bounds as (
      select
        (min(${entityRevisionSummary.createdAt}) at time zone 'UTC')::date::text as earliest,
        (max(${entityRevisionSummary.createdAt}) at time zone 'UTC')::date::text as latest
      from ${entityRevisionSummary}
      where ${entityRevisionSummary.workspaceId} = ${scope}
        and ${entityRevisionSummary.projectId} = ${projectId}
    )
    select
      page.entity_type,
      page.entity_key,
      page.title,
      page.revision,
      page.kind,
      page.status,
      page.status_changed,
      page.section_deltas,
      page.changed_by,
      page.change_reason,
      page.created_at,
      filter_summary.total,
      filter_summary.actors,
      filter_summary.reason_count,
      log_bounds.earliest,
      log_bounds.latest
    from filter_summary
    cross join log_bounds
    left join page on true
    order by page.created_at desc nulls last,
             page.revision desc nulls last,
             page.entity_key asc`;
}

const toQueryRow = (row: RawRevisionSummaryQueryRow): RevisionSummaryQueryRow => {
  const metadata = {
    total: row.total,
    actors: row.actors,
    reasonCount: row.reason_count,
    earliest: row.earliest,
    latest: row.latest,
  };
  if (row.entity_type === null || row.created_at === null) {
    return {
      ...metadata,
      entityType: null,
      entityKey: null,
      title: null,
      revision: null,
      kind: null,
      status: null,
      statusChanged: null,
      sectionDeltas: null,
      changedBy: null,
      changeReason: null,
      createdAt: null,
    };
  }

  const createdAt = row.created_at instanceof Date ? row.created_at : new Date(row.created_at);
  if (Number.isNaN(createdAt.valueOf())) {
    throw new Error(`Revision history returned an invalid timestamp: ${String(row.created_at)}`);
  }
  if (
    row.entity_key === null ||
    row.title === null ||
    row.revision === null ||
    row.kind === null ||
    row.status === null ||
    row.status_changed === null ||
    row.section_deltas === null ||
    row.changed_by === null
  ) {
    throw new Error("Revision history returned a partial projected row.");
  }
  return {
    ...metadata,
    entityType: row.entity_type,
    entityKey: row.entity_key,
    title: row.title,
    revision: row.revision,
    kind: row.kind,
    status: row.status,
    statusChanged: row.status_changed,
    sectionDeltas: row.section_deltas,
    changedBy: row.changed_by,
    changeReason: row.change_reason,
    createdAt,
  };
};

/** One bounded history page and the aggregate values its controls need. */
async function pageByProject(
  scope: WorkspaceScope,
  projectId: string,
  filter: RevisionFilter,
  executor: DbExecutor = db,
): Promise<readonly RevisionSummaryQueryRow[]> {
  const rows = await executeRows<RawRevisionSummaryQueryRow>(
    executor,
    revisionPageStatement(scope, projectId, filter),
  );
  return rows.map(toQueryRow);
}

export const entityRevisionRepository = { pageByProject };
