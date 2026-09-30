import { sql, type SQL } from "drizzle-orm";
import { db } from "../../integration/drizzle/client";
import { executeRows } from "../../integration/drizzle/executeRows";
import { epic } from "../../integration/drizzle/schema/epic";
import { milestone } from "../../integration/drizzle/schema/milestone";
import { projectFragment } from "../../integration/drizzle/schema/projectFragment";
import { rule } from "../../integration/drizzle/schema/rule";
import { stream } from "../../integration/drizzle/schema/stream";
import { task } from "../../integration/drizzle/schema/task";
import type { WorkspaceScope } from "../auth/workspaceScope";
import type { DbExecutor } from "./entity";

export type ProjectWebSearchCandidate = {
  readonly target: string;
  readonly display: string;
  readonly group: "Epics" | "Streams" | "Tasks" | "Milestones" | "Rules" | "Spec fragments";
  readonly title: string;
  readonly kind: string;
  readonly path: string;
  readonly status: string | null;
  readonly excerpt: string | null;
  readonly score: number;
  readonly rankLabel: string;
};

export type ProjectWebSearchResult = {
  readonly candidates: readonly ProjectWebSearchCandidate[];
  readonly total: number;
  readonly indexed: number;
};

const branch = (
  group: string,
  groupOrder: number,
  target: SQL,
  display: SQL,
  title: SQL,
  kind: SQL,
  path: SQL,
  status: SQL,
  excerpt: SQL,
  searchText: SQL,
  fuzzyChars: SQL,
  from: SQL,
  scopeColumn: SQL,
  projectColumn: SQL,
  scope: WorkspaceScope,
  projectId: string,
  query: string,
): SQL => {
  const escaped = escapeLike(query);
  const substring = sql`${searchText} ilike ${`%${escaped}%`}`;
  const selectWhere = (condition: SQL): SQL => sql`
    select ${target} as target, ${display} as display, ${group}::text as group_name,
           ${title} as title, ${kind} as kind, ${path} as path, ${status} as status,
           ${excerpt} as excerpt, ${groupOrder}::integer as group_order,
           case
             when lower(${target}) = ${query} or lower(${display}) = ${query} then 0
             when lower(${target}) like ${`${escaped}%`} or lower(${display}) like ${`${escaped}%`} then 1
             when lower(${title}) like ${`${escaped}%`} then 2
             when lower(${title}) like ${`%${escaped}%`} then 3
             when lower(coalesce(${excerpt}, '')) like ${`%${escaped}%`} then 4
             else 5
           end::integer as score
      from ${from}
     where ${scopeColumn} = ${scope}
       and ${projectColumn} = ${projectId}
       and ${condition}`;

  const substringMatches = selectWhere(substring);
  if (query.length < 3) return substringMatches;
  // Keep the indexable substring predicate out of the fuzzy OR. Postgres can use
  // each `*_web_search_idx` for the common path, while the exact historical fuzzy
  // predicate inspects only titles and excludes rows the first branch found.
  return sql`${substringMatches} union all ${selectWhere(
    sql`not (${substring}) and ${fuzzyChars} @> string_to_array(${query}, null) and spec_tight_subsequence(lower(${title}), ${query})`,
  )}`;
};

/** Keeps `%`, `_` and `\` as literal search-box characters in SQL LIKE patterns. */
const escapeLike = (value: string): string =>
  value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");

export function projectWebSearchStatement(
  scope: WorkspaceScope,
  projectId: string,
  query: string,
  limit: number,
): SQL {
  const branches = [
    branch(
      "Epics",
      0,
      sql`${epic.key}`,
      sql`${epic.key}`,
      sql`${epic.title}`,
      sql`'epic'::text`,
      sql`''::text`,
      sql`${epic.status}`,
      sql`coalesce(${epic.summary}, ${epic.document} -> 'content' ->> 'purpose')`,
      sql`${epic.webSearchText}`,
      sql`${epic.fuzzyChars}`,
      sql`${epic}`,
      sql`${epic.workspaceId}`,
      sql`${epic.projectId}`,
      scope,
      projectId,
      query,
    ),
    branch(
      "Streams",
      1,
      sql`${stream.key}`,
      sql`${stream.key}`,
      sql`${stream.title}`,
      sql`${stream.streamType}`,
      sql`coalesce((select parent.key from ${epic} as parent where parent.id = ${stream.epicId} and parent.workspace_id = ${scope}), '')`,
      sql`${stream.status}`,
      sql`coalesce(nullif(${stream.document} -> 'content' ->> 'purpose', ''), ${stream.summary})`,
      sql`${stream.webSearchText}`,
      sql`${stream.fuzzyChars}`,
      sql`${stream}`,
      sql`${stream.workspaceId}`,
      sql`${stream.projectId}`,
      scope,
      projectId,
      query,
    ),
    branch(
      "Tasks",
      2,
      sql`${task.key}`,
      sql`${task.key}`,
      sql`${task.title}`,
      sql`${task.taskType}`,
      sql`coalesce((select parent.key from ${stream} as parent where parent.id = ${task.streamId} and parent.workspace_id = ${scope}), '')`,
      sql`${task.status}`,
      sql`coalesce(nullif(${task.document} -> 'content' ->> 'objective', ''), ${task.summary})`,
      sql`${task.webSearchText}`,
      sql`${task.fuzzyChars}`,
      sql`${task}`,
      sql`${task.workspaceId}`,
      sql`${task.projectId}`,
      scope,
      projectId,
      query,
    ),
    branch(
      "Milestones",
      3,
      sql`${milestone.key}`,
      sql`${milestone.key}`,
      sql`${milestone.title}`,
      sql`'milestone'::text`,
      sql`''::text`,
      sql`${milestone.status}`,
      sql`coalesce(nullif(${milestone.document} -> 'content' ->> 'goal', ''), ${milestone.summary})`,
      sql`${milestone.webSearchText}`,
      sql`${milestone.fuzzyChars}`,
      sql`${milestone}`,
      sql`${milestone.workspaceId}`,
      sql`${milestone.projectId}`,
      scope,
      projectId,
      query,
    ),
    branch(
      "Rules",
      4,
      sql`${rule.key}`,
      sql`${rule.key}`,
      sql`${rule.title}`,
      sql`'rule'::text`,
      sql`''::text`,
      sql`${rule.status}`,
      sql`coalesce(nullif(${rule.document} -> 'content' ->> 'statement', ''), ${rule.summary})`,
      sql`${rule.webSearchText}`,
      sql`${rule.fuzzyChars}`,
      sql`${rule}`,
      sql`${rule.workspaceId}`,
      sql`${rule.projectId}`,
      scope,
      projectId,
      query,
    ),
    branch(
      "Spec fragments",
      5,
      sql`${projectFragment.ownerKey}`,
      sql`${projectFragment.anchor}`,
      sql`${projectFragment.fragmentText}`,
      sql`${projectFragment.section}`,
      sql`${projectFragment.ownerKey}`,
      sql`null::text`,
      sql`${projectFragment.fragmentText}`,
      sql`${projectFragment.searchText}`,
      sql`${projectFragment.fuzzyChars}`,
      sql`${projectFragment}`,
      sql`${projectFragment.workspaceId}`,
      sql`${projectFragment.projectId}`,
      scope,
      projectId,
      query,
    ),
  ];
  return sql`
    with matches as materialized (${sql.join(branches, sql` union all `)}),
    page as (
      select * from matches
       order by score, group_order, display
       limit ${limit}
    ),
    corpus as (
      select
        (select count(*) from ${epic} where ${epic.workspaceId} = ${scope} and ${epic.projectId} = ${projectId}) +
        (select count(*) from ${stream} where ${stream.workspaceId} = ${scope} and ${stream.projectId} = ${projectId}) +
        (select count(*) from ${task} where ${task.workspaceId} = ${scope} and ${task.projectId} = ${projectId}) +
        (select count(*) from ${milestone} where ${milestone.workspaceId} = ${scope} and ${milestone.projectId} = ${projectId}) +
        (select count(*) from ${rule} where ${rule.workspaceId} = ${scope} and ${rule.projectId} = ${projectId}) +
        (select count(*) from ${projectFragment} where ${projectFragment.workspaceId} = ${scope} and ${projectFragment.projectId} = ${projectId}) as indexed
    )
    select page.target, page.display, page.group_name, page.title, page.kind,
           page.path, page.status, page.excerpt, page.score,
           case page.score
             when 0 then 'exact key'
             when 1 then 'key prefix'
             when 2 then 'title starts'
             when 3 then 'title match'
             when 4 then 'text match'
             else 'fuzzy'
           end as rank_label,
           (select count(*) from matches)::integer as total,
           corpus.indexed::integer as indexed
      from corpus left join page on true
     order by page.score, page.group_order, page.display`;
}

type RawResult = {
  readonly target: string | null;
  readonly display: string | null;
  readonly group_name: string | null;
  readonly title: string | null;
  readonly kind: string | null;
  readonly path: string | null;
  readonly status: string | null;
  readonly excerpt: string | null;
  readonly score: number | null;
  readonly rank_label: string | null;
  readonly total: number;
  readonly indexed: number;
};

type RawCorpusCount = { readonly indexed: number };

const projectSearchCorpusStatement = (scope: WorkspaceScope, projectId: string): SQL => sql`
  select (
    (select count(*) from ${epic} where ${epic.workspaceId} = ${scope} and ${epic.projectId} = ${projectId}) +
    (select count(*) from ${stream} where ${stream.workspaceId} = ${scope} and ${stream.projectId} = ${projectId}) +
    (select count(*) from ${task} where ${task.workspaceId} = ${scope} and ${task.projectId} = ${projectId}) +
    (select count(*) from ${milestone} where ${milestone.workspaceId} = ${scope} and ${milestone.projectId} = ${projectId}) +
    (select count(*) from ${rule} where ${rule.workspaceId} = ${scope} and ${rule.projectId} = ${projectId}) +
    (select count(*) from ${projectFragment} where ${projectFragment.workspaceId} = ${scope} and ${projectFragment.projectId} = ${projectId})
  )::integer as indexed`;

export async function searchProjectCandidates(
  scope: WorkspaceScope,
  projectId: string,
  query: string,
  limit: number,
  executor: DbExecutor = db,
): Promise<ProjectWebSearchResult> {
  if (query.length === 0) {
    const [corpus] = await executeRows<RawCorpusCount>(
      executor,
      projectSearchCorpusStatement(scope, projectId),
    );
    return { candidates: [], total: 0, indexed: corpus?.indexed ?? 0 };
  }
  const rows = await executeRows<RawResult>(
    executor,
    projectWebSearchStatement(scope, projectId, query, limit),
  );
  const first = rows[0];
  return {
    total: first?.total ?? 0,
    indexed: first?.indexed ?? 0,
    candidates: rows.flatMap((row) =>
      row.target === null ||
      row.display === null ||
      row.group_name === null ||
      row.title === null ||
      row.kind === null ||
      row.path === null ||
      row.score === null ||
      row.rank_label === null
        ? []
        : [
            {
              target: row.target,
              display: row.display,
              group: row.group_name as ProjectWebSearchCandidate["group"],
              title: row.title,
              kind: row.kind,
              path: row.path,
              status: row.status,
              excerpt: row.excerpt,
              score: row.score,
              rankLabel: row.rank_label,
            },
          ],
    ),
  };
}
