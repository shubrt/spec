import { type AnyColumn, type SQL, sql } from "drizzle-orm";
import { db } from "../../integration/drizzle/client";
import { epic } from "../../integration/drizzle/schema/epic";
import { stream } from "../../integration/drizzle/schema/stream";
import { task } from "../../integration/drizzle/schema/task";
import type { WorkspaceScope } from "../auth/workspaceScope";
import { ENTITY_TYPE, type EntityType } from "../enums";
import type { DbExecutor } from "./entity";

/**
 * Full-text search across epics, streams and tasks (plan task B15).
 *
 * ## Why one statement and not three
 *
 * The three entity tables are searched in a single `UNION ALL` so that the
 * `LIMIT` and the ranking apply to the *combined* result. Three separate queries
 * with a limit each would return the best ten epics, the best ten streams and the
 * best ten tasks, and the caller would then have to re-rank across incomparable
 * result sets — or, worse, would show ten epics when the one relevant row is a
 * task.
 *
 * ## The two query-shape constraints, both measured with `EXPLAIN`
 *
 * 1. **The GIN index must be used.** Every branch's predicate is
 *    `search_vector @@ <tsquery>`, matching `epic_search_idx` / `stream_search_idx`
 *    / `task_search_idx` exactly. The tenant filter stays a plain `WHERE` column
 *    comparison so it can be applied as a filter on the bitmap heap scan; combining
 *    the two with `OR` — which a fuzzy fallback fused into this query would force —
 *    makes the whole predicate unindexable and turns this into a sequential scan.
 *    That is why `searchFuzzy` below is a **separate statement** rather than an
 *    extra `OR` here.
 *
 * 2. **`ts_headline` must run after the `LIMIT`.** `ts_headline` re-parses and
 *    re-tokenises the text for every row it touches — it is orders of magnitude more
 *    expensive than the `ts_rank` the ordering needs, and computing it for every
 *    match only to discard all but ten is the classic mistake in this query. The
 *    match, the rank and the limit therefore happen in the derived table `m`, and
 *    the headline is in the *outer* select list, which Postgres evaluates above the
 *    `Limit` node. The derived table carries a `LIMIT`, so the planner cannot pull
 *    the outer target list underneath it.
 *
 * ## Empirically: bulk loads need a `VACUUM` before the index is chosen
 *
 * Measured on the local Postgres 17.7: immediately after bulk-inserting 4,000 rows
 * the planner costed `Bitmap Index Scan on stream_search_idx` at 408 and the
 * sequential scan at 232, and chose the sequential scan — because GIN's
 * `fastupdate` pending list has to be scanned in full by every index scan, and
 * `gincostestimate` prices that in. One `VACUUM ANALYZE` later the same index scan
 * costs 12.91 and is chosen. The query shape was identical both times. Production
 * autovacuum handles this; any bulk-load analysis must vacuum first or it will
 * report a sequential scan caused by the pending list rather than the query.
 */

/** What one hit carries out of SQL. `subtype` is the stream/task type; null for an epic. */
export type SearchHitRow = {
  readonly entity: EntityType;
  readonly key: string;
  readonly title: string;
  readonly status: string;
  readonly subtype: string | null;
  readonly rank: number;
  readonly snippet: string;
};

export type SearchQueryOptions = {
  /** Raw words from the agent. Not a query language — see `websearch_to_tsquery`. */
  readonly query: string;
  /** Restrict to one entity kind. Omitted searches all three. */
  readonly entity?: EntityType;
  /** Restrict to one project. Omitted searches the whole workspace. */
  readonly projectId?: string;
  readonly limit: number;
};

/**
 * How the snippet is cut. `MaxWords`/`MinWords` keep a hit to roughly one line —
 * `search_context` exists so a model can scan many hits, and a snippet that runs to
 * a paragraph turns the compact result back into the whole document. The markers
 * are markdown bold because the consumer of this text is a language model.
 */
const HEADLINE_OPTIONS =
  "StartSel=**, StopSel=**, MaxWords=24, MinWords=8, ShortWord=2, MaxFragments=2";

/** How much of the text a fuzzy hit shows. `ts_headline` needs a tsquery and there is none. */
const FUZZY_SNIPPET_CHARS = 160;

/**
 * `websearch_to_tsquery` rather than `to_tsquery` or `plainto_tsquery`: it never
 * raises on punctuation an agent happens to include, and it understands quoted
 * phrases and a leading `-` for exclusion, which is the closest thing to what a
 * model expects from a search box. `'simple'` matches the configuration the
 * generated `search_vector` columns were built with — using any other one here
 * would silently match nothing.
 */
const tsQuery = (query: string): SQL => sql`websearch_to_tsquery('simple', ${query})`;

const projectFilter = (column: AnyColumn, projectId: string | undefined): SQL =>
  projectId === undefined ? sql`` : sql` and ${column} = ${projectId}`;

/**
 * The three search branches, written out rather than generated from a table list.
 *
 * A table-generic helper would need a cast in precisely the expression that carries
 * the tenant filter, which is the one place in this file where a cast is not
 * acceptable: a forgotten or mistyped `workspace_id` comparison still returns
 * plausible-looking rows. Three explicit branches make all three tenant filters
 * readable side by side.
 */
const matchBranches = (
  scope: WorkspaceScope,
  options: SearchQueryOptions,
  query: SQL,
): readonly SQL[] => {
  const wanted = (entity: EntityType): boolean =>
    options.entity === undefined || options.entity === entity;
  const branches: SQL[] = [];

  if (wanted("epic")) {
    branches.push(sql`
      select 'epic'::text as entity, ${epic.key} as key, ${epic.title} as title,
             ${epic.summary} as summary, ${epic.status} as status, null::text as subtype,
             ts_rank(${epic.searchVector}, ${query}) as rank, ${epic.updatedAt} as updated_at
        from ${epic}
       where ${epic.workspaceId} = ${scope}
         and ${epic.searchVector} @@ ${query}${projectFilter(epic.projectId, options.projectId)}`);
  }
  if (wanted("stream")) {
    branches.push(sql`
      select 'stream'::text as entity, ${stream.key} as key, ${stream.title} as title,
             ${stream.summary} as summary, ${stream.status} as status, ${stream.streamType} as subtype,
             ts_rank(${stream.searchVector}, ${query}) as rank, ${stream.updatedAt} as updated_at
        from ${stream}
       where ${stream.workspaceId} = ${scope}
         and ${stream.searchVector} @@ ${query}${projectFilter(stream.projectId, options.projectId)}`);
  }
  if (wanted("task")) {
    branches.push(sql`
      select 'task'::text as entity, ${task.key} as key, ${task.title} as title,
             ${task.summary} as summary, ${task.status} as status, ${task.taskType} as subtype,
             ts_rank(${task.searchVector}, ${query}) as rank, ${task.updatedAt} as updated_at
        from ${task}
       where ${task.workspaceId} = ${scope}
         and ${task.searchVector} @@ ${query}${projectFilter(task.projectId, options.projectId)}`);
  }
  return branches;
};

/**
 * The same three branches for the trigram fallback.
 *
 * `<%` is `pg_trgm`'s word-similarity operator: it compares the query against the
 * best-matching run of words inside the target rather than against the whole
 * string, which is what makes "candidat" find "Review medium-confidence
 * candidates" (measured: `similarity` 0.22, `word_similarity` 0.89). Plain
 * `similarity` on a long title is always below the threshold and would make the
 * fallback dead code.
 */
const fuzzyBranches = (scope: WorkspaceScope, options: SearchQueryOptions): readonly SQL[] => {
  const wanted = (entity: EntityType): boolean =>
    options.entity === undefined || options.entity === entity;
  const branches: SQL[] = [];
  const text = (title: AnyColumn, summary: AnyColumn): SQL =>
    sql`(${title} || ' ' || coalesce(${summary}, ''))`;

  if (wanted("epic")) {
    const haystack = text(epic.title, epic.summary);
    branches.push(sql`
      select 'epic'::text as entity, ${epic.key} as key, ${epic.title} as title,
             ${epic.summary} as summary, ${epic.status} as status, null::text as subtype,
             word_similarity(${options.query}, ${haystack}) as rank, ${epic.updatedAt} as updated_at
        from ${epic}
       where ${epic.workspaceId} = ${scope}
         and ${options.query} <% ${haystack}${projectFilter(epic.projectId, options.projectId)}`);
  }
  if (wanted("stream")) {
    const haystack = text(stream.title, stream.summary);
    branches.push(sql`
      select 'stream'::text as entity, ${stream.key} as key, ${stream.title} as title,
             ${stream.summary} as summary, ${stream.status} as status, ${stream.streamType} as subtype,
             word_similarity(${options.query}, ${haystack}) as rank, ${stream.updatedAt} as updated_at
        from ${stream}
       where ${stream.workspaceId} = ${scope}
         and ${options.query} <% ${haystack}${projectFilter(stream.projectId, options.projectId)}`);
  }
  if (wanted("task")) {
    const haystack = text(task.title, task.summary);
    branches.push(sql`
      select 'task'::text as entity, ${task.key} as key, ${task.title} as title,
             ${task.summary} as summary, ${task.status} as status, ${task.taskType} as subtype,
             word_similarity(${options.query}, ${haystack}) as rank, ${task.updatedAt} as updated_at
        from ${task}
       where ${task.workspaceId} = ${scope}
         and ${options.query} <% ${haystack}${projectFilter(task.projectId, options.projectId)}`);
  }
  return branches;
};

/**
 * Wraps the ranked, limited union so the expensive projection sits above the limit.
 * `snippet` is the only difference between the two callers.
 */
const limitedUnion = (branches: readonly SQL[], limit: number, snippet: SQL): SQL => sql`
  select m.entity, m.key, m.title, m.status, m.subtype, m.rank, ${snippet} as snippet
    from (
      ${sql.join([...branches], sql` union all `)}
      order by rank desc, updated_at desc, key asc
      limit ${limit}
    ) as m`;

const isEntityType = (value: unknown): value is EntityType =>
  ENTITY_TYPE.some((candidate) => candidate === value);

/**
 * One row as the driver hands it back.
 *
 * The statement is written in this file, so the column set and the column types are
 * known: `key`, `title` and `status` are `not null text`, `rank` is `real`. `entity`
 * is the one field typed `unknown`, because it is the one field a future edit to a
 * branch's `select` list could change without any other type complaining — so it is
 * the one field checked at runtime.
 */
type RawSearchRow = {
  readonly entity: unknown;
  readonly key: string;
  readonly title: string;
  readonly status: string;
  readonly subtype: string | null;
  readonly rank: number;
  readonly snippet: string | null;
};

const toHitRow = (row: RawSearchRow): SearchHitRow => {
  if (!isEntityType(row.entity)) {
    throw new Error(`search returned an unknown entity kind: ${JSON.stringify(row.entity)}`);
  }
  return {
    entity: row.entity,
    key: row.key,
    title: row.title,
    status: row.status,
    subtype: row.subtype ?? null,
    rank: row.rank,
    snippet: row.snippet ?? "",
  };
};

const run = async (executor: DbExecutor, statement: SQL): Promise<readonly SearchHitRow[]> => {
  const rows = (await executor.execute(statement)) as unknown as RawSearchRow[];
  return [...rows].map(toHitRow);
};

/**
 * The full-text statement is exported so an operator can `EXPLAIN` the exact query
 * this repository runs rather than a retyped approximation.
 */
export function searchStatement(scope: WorkspaceScope, options: SearchQueryOptions): SQL {
  const query = tsQuery(options.query);
  const headline = sql`ts_headline('simple', coalesce(m.summary, m.title), ${query}, ${HEADLINE_OPTIONS}::text)`;
  return limitedUnion(matchBranches(scope, options, query), options.limit, headline);
}

async function search(
  scope: WorkspaceScope,
  options: SearchQueryOptions,
  executor: DbExecutor = db,
): Promise<readonly SearchHitRow[]> {
  return await run(executor, searchStatement(scope, options));
}

/**
 * The `pg_trgm` fallback, for a query whose words are not in any document —
 * a typo, a truncation, or a name spelled slightly differently.
 *
 * It is a **separate statement run only when `search` found nothing**, for two
 * reasons. Fused into `search` with an `OR` it would make the whole predicate
 * unindexable and cost a sequential scan on every search; and its own predicate is
 * a sequential scan regardless, because there is no `gin_trgm_ops` index on these
 * columns (adding one is out of scope for this task — see the report). The scan is
 * bounded by the tenant filter, and it only ever runs on the path where the agent
 * would otherwise be told "no results".
 */
async function searchFuzzy(
  scope: WorkspaceScope,
  options: SearchQueryOptions,
  executor: DbExecutor = db,
): Promise<readonly SearchHitRow[]> {
  const snippet = sql`left(coalesce(m.summary, m.title), ${FUZZY_SNIPPET_CHARS})`;
  return await run(executor, limitedUnion(fuzzyBranches(scope, options), options.limit, snippet));
}

export const searchRepository = { search, searchFuzzy };
