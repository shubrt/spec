import { sql, type SQL } from "drizzle-orm";

/** The database boundary of the v2 migration. Everything after this file is pure. */
export type SnapshotExecutor = {
  readonly execute: (statement: SQL) => Promise<unknown>;
};

export type DatabaseCapabilities = {
  readonly rule_table: boolean;
  readonly milestone_table: boolean;
  readonly rule_counter: boolean;
  readonly milestone_counter: boolean;
  readonly stream_schedule_columns: boolean;
};

export type ProjectSnapshot = {
  readonly id: string;
  readonly workspace_id: string;
  readonly name: string;
  readonly epic_counter: number;
  readonly stream_counter: number;
  readonly task_counter: number;
  readonly milestone_counter: number | null;
  readonly rule_counter: number | null;
  readonly created_at: string;
  readonly updated_at: string;
};

export type HierarchyEntityType = "epic" | "stream" | "task";
export type VersionedEntityType = HierarchyEntityType | "milestone" | "rule";

export type CurrentEntitySnapshot = {
  readonly entity_type: VersionedEntityType;
  readonly id: string;
  readonly workspace_id: string;
  readonly project_id: string;
  readonly parent_id: string | null;
  readonly key: string;
  readonly status: string;
  readonly subtype: string | null;
  readonly revision: number;
  readonly title: string;
  readonly summary: string | null;
  readonly document: Record<string, unknown>;
  readonly created_at: string;
  readonly updated_at: string;
};

export type RevisionSnapshot = {
  readonly entity_type: string;
  readonly entity_id: string;
  readonly revision: number;
  readonly workspace_id: string;
  readonly project_id: string;
  readonly document: Record<string, unknown>;
  readonly changed_by: string;
  readonly change_reason: string | null;
  readonly created_at: string;
};

export type LinkSnapshot = {
  readonly id: string;
  readonly workspace_id: string;
  readonly project_id: string;
  readonly source_type: string;
  readonly source_id: string;
  readonly target_type: string;
  readonly target_id: string;
  readonly relationship_type: string;
  readonly reason: string | null;
  readonly created_at: string;
};

export type DatabaseSnapshot = {
  readonly capabilities: DatabaseCapabilities;
  readonly projects: readonly ProjectSnapshot[];
  readonly entities: readonly CurrentEntitySnapshot[];
  readonly revisions: readonly RevisionSnapshot[];
  readonly links: readonly LinkSnapshot[];
};

type RawRow = Record<string, unknown>;

const rows = async (executor: SnapshotExecutor, statement: SQL): Promise<readonly RawRow[]> => {
  const result = await executor.execute(statement);
  if (typeof result !== "object" || result === null || !("rows" in result)) {
    throw new Error("Database query returned no rows envelope.");
  }
  const value = (result as { readonly rows?: unknown }).rows;
  if (!Array.isArray(value)) throw new Error("Database query rows envelope is not an array.");
  return value as readonly RawRow[];
};

const stringValue = (row: RawRow, field: string): string => {
  const value = row[field];
  if (typeof value !== "string") {
    throw new Error(`Expected database column ${field} to be text, received ${typeof value}.`);
  }
  return value;
};

const nullableString = (row: RawRow, field: string): string | null => {
  const value = row[field];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new Error(`Expected database column ${field} to be nullable text.`);
  }
  return value;
};

const numberValue = (row: RawRow, field: string): number => {
  const value = row[field];
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Expected database column ${field} to be an integer.`);
  }
  return parsed;
};

const nullableNumber = (row: RawRow, field: string): number | null =>
  row[field] === null || row[field] === undefined ? null : numberValue(row, field);

const booleanValue = (row: RawRow, field: string): boolean => {
  const value = row[field];
  if (typeof value !== "boolean") {
    throw new Error(`Expected database column ${field} to be boolean.`);
  }
  return value;
};

const timestampValue = (row: RawRow, field: string): string => {
  const value = row[field];
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.valueOf())) return parsed.toISOString();
  }
  throw new Error(`Expected database column ${field} to be a timestamp.`);
};

const documentValue = (row: RawRow): Record<string, unknown> => {
  const value = row.document;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected database column document to contain a JSON object.");
  }
  return value as Record<string, unknown>;
};

const readCapabilities = async (executor: SnapshotExecutor): Promise<DatabaseCapabilities> => {
  const [row] = await rows(
    executor,
    sql`
      select
        to_regclass('rule') is not null as rule_table,
        to_regclass('milestone') is not null as milestone_table,
        exists (
          select 1 from information_schema.columns
          where table_schema = current_schema()
            and table_name = 'project'
            and column_name = 'rule_counter'
        ) as rule_counter,
        exists (
          select 1 from information_schema.columns
          where table_schema = current_schema()
            and table_name = 'project'
            and column_name = 'milestone_counter'
        ) as milestone_counter,
        exists (
          select 1 from information_schema.columns
          where table_schema = current_schema()
            and table_name = 'stream'
            and column_name = 'milestone_id'
        ) and exists (
          select 1 from information_schema.columns
          where table_schema = current_schema()
            and table_name = 'stream'
            and column_name = 'roadmap_rank'
        ) as stream_schedule_columns
    `,
  );
  if (!row) throw new Error("Database capability query returned no row.");
  return {
    rule_table: booleanValue(row, "rule_table"),
    milestone_table: booleanValue(row, "milestone_table"),
    rule_counter: booleanValue(row, "rule_counter"),
    milestone_counter: booleanValue(row, "milestone_counter"),
    stream_schedule_columns: booleanValue(row, "stream_schedule_columns"),
  };
};

const readProjects = async (
  executor: SnapshotExecutor,
  capabilities: DatabaseCapabilities,
): Promise<readonly ProjectSnapshot[]> => {
  const counterProjection = [
    capabilities.milestone_counter ? "milestone_counter" : "null::integer as milestone_counter",
    capabilities.rule_counter ? "rule_counter" : "null::integer as rule_counter",
  ].join(", ");
  const result = await rows(
    executor,
    sql.raw(`
      select id::text as id, workspace_id::text as workspace_id, name,
             epic_counter, stream_counter, task_counter, ${counterProjection},
             created_at, updated_at
      from project
      order by workspace_id, id
    `),
  );
  return result.map((row) => ({
    id: stringValue(row, "id"),
    workspace_id: stringValue(row, "workspace_id"),
    name: stringValue(row, "name"),
    epic_counter: numberValue(row, "epic_counter"),
    stream_counter: numberValue(row, "stream_counter"),
    task_counter: numberValue(row, "task_counter"),
    milestone_counter: nullableNumber(row, "milestone_counter"),
    rule_counter: nullableNumber(row, "rule_counter"),
    created_at: timestampValue(row, "created_at"),
    updated_at: timestampValue(row, "updated_at"),
  }));
};

const hierarchyQueries = {
  epic: sql`
    select 'epic' as entity_type, id::text as id, workspace_id::text as workspace_id,
           project_id::text as project_id, null::text as parent_id, key, status,
           null::text as subtype, revision, title, summary, document, created_at, updated_at
    from epic order by workspace_id, project_id, id
  `,
  stream: sql`
    select 'stream' as entity_type, id::text as id, workspace_id::text as workspace_id,
           project_id::text as project_id, epic_id::text as parent_id, key, status,
           stream_type as subtype, revision, title, summary, document, created_at, updated_at
    from stream order by workspace_id, project_id, id
  `,
  task: sql`
    select 'task' as entity_type, id::text as id, workspace_id::text as workspace_id,
           project_id::text as project_id, stream_id::text as parent_id, key, status,
           task_type as subtype, revision, title, summary, document, created_at, updated_at
    from task order by workspace_id, project_id, id
  `,
} as const;

const optionalEntityQuery = {
  rule: sql`
    select 'rule' as entity_type, id::text as id, workspace_id::text as workspace_id,
           project_id::text as project_id, null::text as parent_id, key, status,
           null::text as subtype, revision, title, summary, document, created_at, updated_at
    from rule order by workspace_id, project_id, id
  `,
  milestone: sql`
    select 'milestone' as entity_type, id::text as id, workspace_id::text as workspace_id,
           project_id::text as project_id, null::text as parent_id, key, status,
           null::text as subtype, revision, title, summary, document, created_at, updated_at
    from milestone order by workspace_id, project_id, id
  `,
} as const;

const readEntityRows = async (
  executor: SnapshotExecutor,
  capabilities: DatabaseCapabilities,
): Promise<readonly CurrentEntitySnapshot[]> => {
  const result = [
    ...(await rows(executor, hierarchyQueries.epic)),
    ...(await rows(executor, hierarchyQueries.stream)),
    ...(await rows(executor, hierarchyQueries.task)),
    ...(capabilities.rule_table ? await rows(executor, optionalEntityQuery.rule) : []),
    ...(capabilities.milestone_table ? await rows(executor, optionalEntityQuery.milestone) : []),
  ];
  return result.map((row) => ({
    entity_type: stringValue(row, "entity_type") as VersionedEntityType,
    id: stringValue(row, "id"),
    workspace_id: stringValue(row, "workspace_id"),
    project_id: stringValue(row, "project_id"),
    parent_id: nullableString(row, "parent_id"),
    key: stringValue(row, "key"),
    status: stringValue(row, "status"),
    subtype: nullableString(row, "subtype"),
    revision: numberValue(row, "revision"),
    title: stringValue(row, "title"),
    summary: nullableString(row, "summary"),
    document: documentValue(row),
    created_at: timestampValue(row, "created_at"),
    updated_at: timestampValue(row, "updated_at"),
  }));
};

const readRevisions = async (executor: SnapshotExecutor): Promise<readonly RevisionSnapshot[]> => {
  const result = await rows(
    executor,
    sql`
      select entity_type, entity_id::text as entity_id, revision,
             workspace_id::text as workspace_id, project_id::text as project_id,
             document, changed_by, change_reason, created_at
      from entity_revision
      order by workspace_id, project_id, entity_type, entity_id, revision
    `,
  );
  return result.map((row) => ({
    entity_type: stringValue(row, "entity_type"),
    entity_id: stringValue(row, "entity_id"),
    revision: numberValue(row, "revision"),
    workspace_id: stringValue(row, "workspace_id"),
    project_id: stringValue(row, "project_id"),
    document: documentValue(row),
    changed_by: stringValue(row, "changed_by"),
    change_reason: nullableString(row, "change_reason"),
    created_at: timestampValue(row, "created_at"),
  }));
};

const readLinks = async (executor: SnapshotExecutor): Promise<readonly LinkSnapshot[]> => {
  const result = await rows(
    executor,
    sql`
      select id::text as id, workspace_id::text as workspace_id,
             project_id::text as project_id, source_type,
             source_id::text as source_id, target_type,
             target_id::text as target_id, relationship_type, reason, created_at
      from entity_link
      order by workspace_id, project_id, source_type, source_id,
               relationship_type, target_type, target_id, id
    `,
  );
  return result.map((row) => ({
    id: stringValue(row, "id"),
    workspace_id: stringValue(row, "workspace_id"),
    project_id: stringValue(row, "project_id"),
    source_type: stringValue(row, "source_type"),
    source_id: stringValue(row, "source_id"),
    target_type: stringValue(row, "target_type"),
    target_id: stringValue(row, "target_id"),
    relationship_type: stringValue(row, "relationship_type"),
    reason: nullableString(row, "reason"),
    created_at: timestampValue(row, "created_at"),
  }));
};

/**
 * Captures one mutually consistent database image. The caller is responsible for
 * supplying a `REPEATABLE READ, READ ONLY` transaction.
 */
export async function readDatabaseSnapshot(executor: SnapshotExecutor): Promise<DatabaseSnapshot> {
  const capabilities = await readCapabilities(executor);
  // A node-postgres transaction owns one client connection. Keep its statements
  // sequential so no query is started while the client is still consuming the
  // previous result; the transaction snapshot already provides consistency.
  const projects = await readProjects(executor, capabilities);
  const entities = await readEntityRows(executor, capabilities);
  const revisions = await readRevisions(executor);
  const links = await readLinks(executor);
  return { capabilities, projects, entities, revisions, links };
}
