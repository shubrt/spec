import { sql, type SQL } from "drizzle-orm";
import { RELATIONSHIP_TYPE } from "../../src/domain/enums";
import { parseDocument } from "../../src/domain/schema/document";
import {
  buildV2PreflightReport,
  canonicalJson,
  sha256,
  type ProjectPreflightReport,
} from "./preflight";
import {
  readDatabaseSnapshot,
  type CurrentEntitySnapshot,
  type DatabaseCapabilities,
  type DatabaseSnapshot,
  type LinkSnapshot,
  type ProjectSnapshot,
  type RevisionSnapshot,
  type SnapshotExecutor,
} from "./readSnapshot";
import { STREAM_RESOLUTIONS } from "./resolutions";
import {
  buildV2MigrationPlan,
  type PlannedEntityBaseline,
  type PlannedRuleBaseline,
  type PlannedStreamResolution,
  type ProjectCounterPlan,
  type V2MigrationPlan,
} from "./transform";

type RawRow = Record<string, unknown>;

type ReviewedProjectAudit = {
  readonly projectId: string;
  readonly currentEntities: number;
  readonly revisions: number;
  readonly links: number;
  readonly currentRowsSha256: string;
  readonly revisionRowsSha256: string;
  readonly linkRowsSha256: string;
};

export type V2MigrationManifest = {
  readonly manifest_version: "zpecs.v2.apply.manifest.v1";
  readonly plan_version: V2MigrationPlan["planVersion"];
  readonly writes_performed: true;
  readonly applied_at: string;
  readonly actor: typeof MIGRATION_ACTOR;
  readonly change_reason: typeof MIGRATION_CHANGE_REASON;
  readonly source: {
    readonly projects: number;
    readonly current_entities: number;
    readonly revisions: number;
    readonly links: number;
    readonly reviewed_project_audits: readonly ReviewedProjectAudit[];
  };
  readonly applied: {
    readonly entity_baselines: number;
    readonly rules: number;
    readonly rule_mappings: readonly {
      readonly legacy_id: string;
      readonly legacy_content_sha256: string;
      readonly key: string;
      readonly entity_id: string;
      readonly revision: 1;
    }[];
    readonly revision_rows_added: number;
    readonly project_counters_updated: number;
    readonly resolutions: readonly PlannedStreamResolution[];
    readonly status_changes: readonly {
      readonly entity_id: string;
      readonly legacy_key: string;
      readonly key: string;
      readonly from: string;
      readonly to: string;
    }[];
  };
  readonly verification: {
    readonly database_capabilities: DatabaseCapabilities;
    readonly current_entities: number;
    readonly revisions: number;
    readonly links: number;
    readonly parsed_current_documents: number;
    readonly entity_baselines_verified: number;
    readonly rules_and_legacy_round_trips_verified: number;
    readonly migration_revision_rows_verified: number;
    readonly unscheduled_streams_verified: number;
    readonly legacy_revision_rows_verified: number;
    readonly legacy_links_verified: number;
    readonly project_counters_verified: number;
    readonly current_documents_sha256: string;
    readonly revision_rows_sha256: string;
    readonly link_rows_sha256: string;
  };
  readonly decisions: readonly string[];
};

export const V2_MIGRATION_TRANSACTION = {
  isolationLevel: "serializable",
  accessMode: "read write",
} as const;

const MIGRATION_ACTOR = "system:zpecs-v2-migration";
const MIGRATION_CHANGE_REASON =
  "One-off, reviewed baseline migration from the immutable v1 document to the v2 model.";

/**
 * The source manifest reviewed on 2026-08-10. These hashes cover every current
 * relational field and document, every immutable revision row and every link.
 * An additive schema push does not change them; any intervening data write does.
 */
const REVIEWED_SOURCE: readonly ReviewedProjectAudit[] = [
  {
    projectId: "7aa2730f-487e-418d-be1f-71b3404dcd71",
    currentEntities: 95,
    revisions: 133,
    links: 32,
    currentRowsSha256: "f004aa008a5629e31509ce2a1d329e64ecc22308349c9984ff91138e1738f7c7",
    revisionRowsSha256: "3a46f764677cca2c3e5e6964d6de606484083be2e6bdd87f7779be2b2f54ceb4",
    linkRowsSha256: "25fdb77efec72a92a9755dcd935ca83c91b3670e0e4426d0854308a8d2dd5ba9",
  },
  {
    projectId: "bd6f2999-9afb-4af9-b6bb-fea561b3b710",
    currentEntities: 0,
    revisions: 0,
    links: 0,
    currentRowsSha256: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
    revisionRowsSha256: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
    linkRowsSha256: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
  },
] as const;

const EXPECTED_SOURCE_COUNTS = {
  projects: 2,
  currentEntities: 95,
  revisions: 133,
  links: 32,
  streams: 49,
  rulesAfterCutover: 99,
} as const;

const rows = async (executor: SnapshotExecutor, statement: SQL): Promise<readonly RawRow[]> => {
  const result = await executor.execute(statement);
  if (typeof result !== "object" || result === null || !("rows" in result)) {
    throw new Error("Migration database query returned no rows envelope.");
  }
  const value = (result as { readonly rows?: unknown }).rows;
  if (!Array.isArray(value)) {
    throw new Error("Migration database query rows envelope is not an array.");
  }
  return value as readonly RawRow[];
};

const stringValue = (row: RawRow, field: string): string => {
  const value = row[field];
  if (typeof value !== "string") {
    throw new Error(`Migration database column ${field} is not text.`);
  }
  return value;
};

const booleanValue = (row: RawRow, field: string): boolean => {
  const value = row[field];
  if (typeof value !== "boolean") {
    throw new Error(`Migration database column ${field} is not boolean.`);
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
  throw new Error(`Migration database column ${field} is not a timestamp.`);
};

const integerValue = (row: RawRow, field: string): number => {
  const value = row[field];
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Migration database column ${field} is not an integer.`);
  }
  return parsed;
};

const requireSingleRow = async (
  executor: SnapshotExecutor,
  statement: SQL,
  operation: string,
): Promise<RawRow> => {
  const result = await rows(executor, statement);
  if (result.length !== 1 || result[0] === undefined) {
    throw new Error(`${operation} affected ${String(result.length)} rows; expected exactly one.`);
  }
  return result[0];
};

const assertSerializableTransaction = async (executor: SnapshotExecutor): Promise<void> => {
  const row = await requireSingleRow(
    executor,
    sql`
      select current_setting('transaction_isolation') as isolation,
             current_setting('transaction_read_only') as read_only
    `,
    "Transaction mode check",
  );
  const isolation = stringValue(row, "isolation");
  const readOnly = stringValue(row, "read_only");
  if (isolation !== "serializable" || readOnly !== "off") {
    throw new Error(
      `v2 apply requires an explicit SERIALIZABLE, READ WRITE transaction; received ${isolation}, read_only=${readOnly}.`,
    );
  }
};

const readCapabilities = async (executor: SnapshotExecutor): Promise<DatabaseCapabilities> => {
  const row = await requireSingleRow(
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
    "Schema capability check",
  );
  return {
    rule_table: booleanValue(row, "rule_table"),
    milestone_table: booleanValue(row, "milestone_table"),
    rule_counter: booleanValue(row, "rule_counter"),
    milestone_counter: booleanValue(row, "milestone_counter"),
    stream_schedule_columns: booleanValue(row, "stream_schedule_columns"),
  };
};

const assertCapabilities = (capabilities: DatabaseCapabilities): void => {
  const missing = Object.entries(capabilities)
    .filter(([, available]) => !available)
    .map(([capability]) => capability);
  if (missing.length > 0) {
    throw new Error(`v2 schema is incomplete; missing capabilities: ${missing.join(", ")}.`);
  }
};

const lockMigrationTables = async (executor: SnapshotExecutor): Promise<void> => {
  // SHARE ROW EXCLUSIVE keeps reads available during the short cutover but
  // conflicts with every application INSERT/UPDATE/DELETE lock mode.
  await executor.execute(sql`
    lock table workspace, project, milestone, rule, epic, stream, task,
               entity_revision, entity_link
    in share row exclusive mode
  `);
};

const assertUnscheduledBaselineStreams = async (executor: SnapshotExecutor): Promise<number> => {
  const row = await requireSingleRow(
    executor,
    sql`
      select count(*)::integer as total,
             count(*) filter (
               where milestone_id is not null or roadmap_rank is not null
             )::integer as scheduled
      from stream
    `,
    "Stream roadmap-column check",
  );
  const total = integerValue(row, "total");
  const scheduled = integerValue(row, "scheduled");
  if (total !== EXPECTED_SOURCE_COUNTS.streams || scheduled !== 0) {
    throw new Error(
      `Reviewed baseline requires 49 unscheduled Streams; received total=${String(total)}, scheduled=${String(scheduled)}.`,
    );
  }
  return total;
};

const projectReportById = (
  reports: readonly ProjectPreflightReport[],
  projectId: string,
): ProjectPreflightReport => {
  const report = reports.find((candidate) => candidate.project_id === projectId);
  if (report === undefined) throw new Error(`Preflight has no project ${projectId}.`);
  return report;
};

const assertReviewedSource = (
  snapshot: DatabaseSnapshot,
  reports: readonly ProjectPreflightReport[],
): void => {
  if (
    snapshot.projects.length !== EXPECTED_SOURCE_COUNTS.projects ||
    snapshot.entities.length !== EXPECTED_SOURCE_COUNTS.currentEntities ||
    snapshot.revisions.length !== EXPECTED_SOURCE_COUNTS.revisions ||
    snapshot.links.length !== EXPECTED_SOURCE_COUNTS.links
  ) {
    throw new Error(
      `Locked source inventory differs from the reviewed baseline: projects=${String(snapshot.projects.length)}, current=${String(snapshot.entities.length)}, revisions=${String(snapshot.revisions.length)}, links=${String(snapshot.links.length)}.`,
    );
  }
  if (reports.length !== REVIEWED_SOURCE.length) {
    throw new Error(`Locked source has ${String(reports.length)} projects; expected 2.`);
  }

  for (const expected of REVIEWED_SOURCE) {
    const report = projectReportById(reports, expected.projectId);
    const current = Object.values(report.counts.current).reduce((sum, count) => sum + count, 0);
    const revisions = Object.values(report.counts.revisions).reduce((sum, count) => sum + count, 0);
    if (
      current !== expected.currentEntities ||
      revisions !== expected.revisions ||
      report.counts.links !== expected.links ||
      report.audit.current_rows_sha256 !== expected.currentRowsSha256 ||
      report.audit.revision_rows_sha256 !== expected.revisionRowsSha256 ||
      report.audit.link_rows_sha256 !== expected.linkRowsSha256
    ) {
      throw new Error(
        `Project ${expected.projectId} no longer matches its reviewed current/revision/link audit hashes.`,
      );
    }
  }
};

const assertRelationshipAllowlist = (links: readonly LinkSnapshot[]): void => {
  const allowed = new Set<string>(RELATIONSHIP_TYPE);
  const invalid = links.filter((link) => !allowed.has(link.relationship_type));
  if (invalid.length > 0) {
    throw new Error(
      `Source contains non-v2 relationship types: ${[
        ...new Set(invalid.map((link) => link.relationship_type)),
      ].join(", ")}.`,
    );
  }
};

const entityIdentity = (entity: { readonly entity_type: string; readonly id: string }): string =>
  `${entity.entity_type}:${entity.id}`;

const revisionIdentity = (revision: {
  readonly entity_type: string;
  readonly entity_id: string;
  readonly revision: number;
}): string => `${revision.entity_type}:${revision.entity_id}:r${String(revision.revision)}`;

const assertPlanSourceAudit = (
  plan: V2MigrationPlan,
  reports: readonly ProjectPreflightReport[],
): void => {
  for (const report of reports) {
    const current = plan.sourceAudit.currentRowsSha256.find(
      (candidate) => candidate.projectId === report.project_id,
    );
    const revisions = plan.sourceAudit.revisionRowsSha256.find(
      (candidate) => candidate.projectId === report.project_id,
    );
    const links = plan.sourceAudit.linkRowsSha256.find(
      (candidate) => candidate.projectId === report.project_id,
    );
    if (
      current?.sha256 !== report.audit.current_rows_sha256 ||
      revisions?.sha256 !== report.audit.revision_rows_sha256 ||
      links?.sha256 !== report.audit.link_rows_sha256
    ) {
      throw new Error(`Migration plan source audit drifted for project ${report.project_id}.`);
    }
  }
};

const assertPlanRelationalInvariants = (
  snapshot: DatabaseSnapshot,
  plan: V2MigrationPlan,
): void => {
  if (
    plan.entities.length !== EXPECTED_SOURCE_COUNTS.currentEntities ||
    plan.rules.length !== EXPECTED_SOURCE_COUNTS.rulesAfterCutover
  ) {
    throw new Error(
      `Migration plan has ${String(plan.entities.length)} entity baselines and ${String(plan.rules.length)} Rules; expected 95 and 99.`,
    );
  }
  const sourceByIdentity = new Map(
    snapshot.entities.map((entity) => [entityIdentity(entity), entity]),
  );
  const statusResolutionById = new Map(
    STREAM_RESOLUTIONS.filter((resolution) => resolution.status !== undefined).map((resolution) => [
      resolution.entityId,
      resolution.status,
    ]),
  );
  const plannedIdentities = new Set<string>();
  const plannedKeys = new Set<string>();

  for (const entity of plan.entities) {
    const identity = `${entity.entityType}:${entity.entityId}`;
    const source = sourceByIdentity.get(identity);
    if (source === undefined) throw new Error(`Plan entity ${identity} has no locked source row.`);
    if (plannedIdentities.has(identity)) throw new Error(`Plan duplicates entity ${identity}.`);
    plannedIdentities.add(identity);
    const scopedKey = `${entity.projectId}:${entity.entityType}:${entity.key}`;
    if (plannedKeys.has(scopedKey)) throw new Error(`Plan duplicates key ${scopedKey}.`);
    plannedKeys.add(scopedKey);

    const expectedStatus = statusResolutionById.get(entity.entityId) ?? source.status;
    if (
      entity.workspaceId !== source.workspace_id ||
      entity.projectId !== source.project_id ||
      entity.legacyKey !== source.key ||
      entity.previousRevision !== source.revision ||
      entity.revision !== source.revision + 1 ||
      entity.title !== source.title ||
      entity.summary !== source.summary ||
      entity.status !== expectedStatus ||
      entity.beforeDocumentSha256 !== sha256(source.document)
    ) {
      throw new Error(`${identity} changes an unreviewed relational field or source document.`);
    }
  }

  for (const source of snapshot.entities) {
    if (
      (source.entity_type === "epic" ||
        source.entity_type === "stream" ||
        source.entity_type === "task") &&
      !plannedIdentities.has(entityIdentity(source))
    ) {
      throw new Error(`Locked source ${entityIdentity(source)} has no migration baseline.`);
    }
  }
};

const assertPlanRuleInvariants = (rules: readonly PlannedRuleBaseline[]): void => {
  const identities = new Set<string>();
  const keys = new Set<string>();
  for (const rule of rules) {
    const scopedKey = `${rule.projectId}:${rule.key}`;
    if (identities.has(rule.entityId) || keys.has(scopedKey)) {
      throw new Error(`Migration plan duplicates Rule ${rule.key} or UUID ${rule.entityId}.`);
    }
    identities.add(rule.entityId);
    keys.add(scopedKey);
    if (
      !/^R-[1-9][0-9]*$/.test(rule.key) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(rule.entityId)
    ) {
      throw new Error(`Rule ${rule.key} has a non-canonical key or deterministic UUID.`);
    }

    const contentValue = rule.document.content;
    if (typeof contentValue !== "object" || contentValue === null || Array.isArray(contentValue)) {
      throw new Error(`Rule ${rule.key} has no v2 content object.`);
    }
    const content = contentValue as Record<string, unknown>;
    const statement = content.statement;
    if (typeof statement !== "string") {
      throw new Error(`Rule ${rule.key} has no statement for legacy round-trip verification.`);
    }
    const legacyBody = {
      rule: statement,
      ...(content.impact === undefined ? {} : { impact: content.impact }),
      ...(content.consequence === undefined ? {} : { consequence: content.consequence }),
    };
    if (
      sha256(legacyBody) !== rule.legacyContentSha256 ||
      sha256(rule.document) !== rule.documentSha256
    ) {
      throw new Error(`Rule ${rule.key} failed exact legacy-content round-trip verification.`);
    }
  }
};

const assertPlan = (
  snapshot: DatabaseSnapshot,
  reports: readonly ProjectPreflightReport[],
  plan: V2MigrationPlan,
): void => {
  if (plan.issues.length > 0) {
    throw new Error(`v2 migration plan is invalid:\n${plan.issues.join("\n")}`);
  }
  assertPlanSourceAudit(plan, reports);
  assertPlanRelationalInvariants(snapshot, plan);
  assertPlanRuleInvariants(plan.rules);
};

const asJsonb = (value: unknown): SQL => sql`${canonicalJson(value)}::jsonb`;

const insertRule = async (executor: SnapshotExecutor, rule: PlannedRuleBaseline): Promise<void> => {
  const row = await requireSingleRow(
    executor,
    sql`
      insert into rule (
        id, workspace_id, project_id, key, status, revision,
        title, summary, document, created_at, updated_at
      ) values (
        ${rule.entityId}::uuid, ${rule.workspaceId}::uuid, ${rule.projectId}::uuid,
        ${rule.key}, ${rule.status}, ${rule.revision}, ${rule.title}, ${rule.summary},
        ${asJsonb(rule.document)}, transaction_timestamp(), transaction_timestamp()
      )
      returning id::text as id
    `,
    `Insert Rule ${rule.key}`,
  );
  if (stringValue(row, "id") !== rule.entityId) {
    throw new Error(`Insert Rule ${rule.key} returned the wrong id.`);
  }
};

const insertRevision = async (
  executor: SnapshotExecutor,
  value: {
    readonly entityType: string;
    readonly entityId: string;
    readonly revision: number;
    readonly workspaceId: string;
    readonly projectId: string;
    readonly document: Readonly<Record<string, unknown>>;
  },
): Promise<void> => {
  const row = await requireSingleRow(
    executor,
    sql`
      insert into entity_revision (
        entity_type, entity_id, revision, workspace_id, project_id,
        document, changed_by, change_reason, created_at
      ) values (
        ${value.entityType}, ${value.entityId}::uuid, ${value.revision},
        ${value.workspaceId}::uuid, ${value.projectId}::uuid,
        ${asJsonb(value.document)}, ${MIGRATION_ACTOR}, ${MIGRATION_CHANGE_REASON},
        transaction_timestamp()
      )
      returning entity_type, entity_id::text as entity_id, revision
    `,
    `Insert ${value.entityType} ${value.entityId} revision ${String(value.revision)}`,
  );
  if (
    stringValue(row, "entity_type") !== value.entityType ||
    stringValue(row, "entity_id") !== value.entityId ||
    Number(row.revision) !== value.revision
  ) {
    throw new Error(`Revision insert returned the wrong identity for ${value.entityId}.`);
  }
};

const updateEntity = async (
  executor: SnapshotExecutor,
  entity: PlannedEntityBaseline,
  source: CurrentEntitySnapshot,
): Promise<void> => {
  const table = sql.raw(entity.entityType);
  const row = await requireSingleRow(
    executor,
    sql`
      update ${table}
      set key = ${entity.key},
          status = ${entity.status},
          revision = ${entity.revision},
          document = ${asJsonb(entity.document)},
          updated_at = transaction_timestamp()
      where id = ${entity.entityId}::uuid
        and workspace_id = ${entity.workspaceId}::uuid
        and project_id = ${entity.projectId}::uuid
        and key = ${entity.legacyKey}
        and revision = ${entity.previousRevision}
        and status = ${source.status}
        and title = ${source.title}
        and summary is not distinct from ${source.summary}
        and document = ${asJsonb(source.document)}
      returning id::text as id
    `,
    `Update ${entity.legacyKey} to ${entity.key}`,
  );
  if (stringValue(row, "id") !== entity.entityId) {
    throw new Error(`Update ${entity.legacyKey} returned the wrong id.`);
  }
};

const updateProjectCounters = async (
  executor: SnapshotExecutor,
  counters: ProjectCounterPlan,
  source: ProjectSnapshot,
): Promise<void> => {
  const row = await requireSingleRow(
    executor,
    sql`
      update project
      set epic_counter = ${counters.epic},
          stream_counter = ${counters.stream},
          task_counter = ${counters.task},
          milestone_counter = ${counters.milestone},
          rule_counter = ${counters.rule},
          updated_at = transaction_timestamp()
      where id = ${counters.projectId}::uuid
        and workspace_id = ${source.workspace_id}::uuid
        and name = ${source.name}
        and epic_counter = ${source.epic_counter}
        and stream_counter = ${source.stream_counter}
        and task_counter = ${source.task_counter}
        and milestone_counter is not distinct from ${source.milestone_counter}
        and rule_counter is not distinct from ${source.rule_counter}
      returning id::text as id
    `,
    `Update counters for project ${counters.projectId}`,
  );
  if (stringValue(row, "id") !== counters.projectId) {
    throw new Error(`Counter update for ${counters.projectId} returned the wrong id.`);
  }
};

const writePlan = async (
  executor: SnapshotExecutor,
  source: DatabaseSnapshot,
  plan: V2MigrationPlan,
): Promise<void> => {
  const sourceEntityByIdentity = new Map(
    source.entities.map((entity) => [entityIdentity(entity), entity]),
  );
  const sourceProjectById = new Map(source.projects.map((project) => [project.id, project]));

  for (const rule of plan.rules) {
    await insertRule(executor, rule);
    await insertRevision(executor, {
      entityType: "rule",
      entityId: rule.entityId,
      revision: rule.revision,
      workspaceId: rule.workspaceId,
      projectId: rule.projectId,
      document: rule.document,
    });
  }
  for (const entity of plan.entities) {
    const sourceEntity = sourceEntityByIdentity.get(`${entity.entityType}:${entity.entityId}`);
    if (sourceEntity === undefined) throw new Error(`Missing source row for ${entity.entityId}.`);
    await updateEntity(executor, entity, sourceEntity);
    await insertRevision(executor, {
      entityType: entity.entityType,
      entityId: entity.entityId,
      revision: entity.revision,
      workspaceId: entity.workspaceId,
      projectId: entity.projectId,
      document: entity.document,
    });
  }
  for (const counters of plan.counters) {
    const sourceProject = sourceProjectById.get(counters.projectId);
    if (sourceProject === undefined) {
      throw new Error(`Missing source project ${counters.projectId}.`);
    }
    await updateProjectCounters(executor, counters, sourceProject);
  }
};

const assertExactLegacyRows = <Value>(
  label: string,
  before: readonly Value[],
  after: readonly Value[],
  identity: (value: Value) => string,
): void => {
  const afterByIdentity = new Map(after.map((value) => [identity(value), value]));
  for (const source of before) {
    const current = afterByIdentity.get(identity(source));
    if (current === undefined || sha256(current) !== sha256(source)) {
      throw new Error(`${label} ${identity(source)} changed during v2 apply.`);
    }
  }
};

const assertEntityAfter = (
  source: CurrentEntitySnapshot,
  planned: PlannedEntityBaseline,
  current: CurrentEntitySnapshot,
): void => {
  if (
    current.entity_type !== source.entity_type ||
    current.id !== source.id ||
    current.workspace_id !== source.workspace_id ||
    current.project_id !== source.project_id ||
    current.parent_id !== source.parent_id ||
    current.subtype !== source.subtype ||
    current.title !== source.title ||
    current.summary !== source.summary ||
    current.created_at !== source.created_at ||
    current.key !== planned.key ||
    current.status !== planned.status ||
    current.revision !== planned.revision ||
    sha256(current.document) !== planned.documentSha256
  ) {
    throw new Error(`${planned.key} failed post-write relational/document verification.`);
  }
};

const assertRuleAfter = (planned: PlannedRuleBaseline, current: CurrentEntitySnapshot): void => {
  if (
    current.entity_type !== "rule" ||
    current.id !== planned.entityId ||
    current.workspace_id !== planned.workspaceId ||
    current.project_id !== planned.projectId ||
    current.parent_id !== null ||
    current.subtype !== null ||
    current.key !== planned.key ||
    current.status !== planned.status ||
    current.revision !== planned.revision ||
    current.title !== planned.title ||
    current.summary !== planned.summary ||
    sha256(current.document) !== planned.documentSha256
  ) {
    throw new Error(`${planned.key} failed post-write Rule verification.`);
  }
};

const assertRevisionAfter = (
  revisions: ReadonlyMap<string, RevisionSnapshot>,
  value: {
    readonly entityType: string;
    readonly entityId: string;
    readonly revision: number;
    readonly workspaceId: string;
    readonly projectId: string;
    readonly documentSha256: string;
  },
): void => {
  const identity = `${value.entityType}:${value.entityId}:r${String(value.revision)}`;
  const revision = revisions.get(identity);
  if (
    revision === undefined ||
    revision.workspace_id !== value.workspaceId ||
    revision.project_id !== value.projectId ||
    revision.changed_by !== MIGRATION_ACTOR ||
    revision.change_reason !== MIGRATION_CHANGE_REASON ||
    sha256(revision.document) !== value.documentSha256
  ) {
    throw new Error(`${identity} failed post-write revision verification.`);
  }
};

const assertProjectAfter = (
  source: ProjectSnapshot,
  planned: ProjectCounterPlan,
  current: ProjectSnapshot,
): void => {
  if (
    current.id !== source.id ||
    current.workspace_id !== source.workspace_id ||
    current.name !== source.name ||
    current.created_at !== source.created_at ||
    current.epic_counter !== planned.epic ||
    current.stream_counter !== planned.stream ||
    current.task_counter !== planned.task ||
    current.milestone_counter !== planned.milestone ||
    current.rule_counter !== planned.rule
  ) {
    throw new Error(`Project ${planned.projectId} failed post-write counter verification.`);
  }
};

const currentDocumentAudit = (entities: readonly CurrentEntitySnapshot[]): string =>
  sha256(
    [...entities]
      .sort((left, right) => entityIdentity(left).localeCompare(entityIdentity(right)))
      .map((entity) => ({
        identity: `${entityIdentity(entity)}:r${String(entity.revision)}`,
        document_sha256: sha256(entity.document),
      })),
  );

const rowAudit = <Value>(values: readonly Value[], identity: (value: Value) => string): string =>
  sha256(
    [...values]
      .sort((left, right) => identity(left).localeCompare(identity(right)))
      .map((value) => ({ identity: identity(value), row_sha256: sha256(value) })),
  );

const verifyAppliedPlan = (
  source: DatabaseSnapshot,
  current: DatabaseSnapshot,
  plan: V2MigrationPlan,
  unscheduledStreams: number,
): V2MigrationManifest["verification"] => {
  assertCapabilities(current.capabilities);
  const expectedCurrent = source.entities.length + plan.rules.length;
  const expectedRevisions = source.revisions.length + plan.entities.length + plan.rules.length;
  if (
    current.entities.length !== expectedCurrent ||
    current.revisions.length !== expectedRevisions ||
    current.links.length !== source.links.length
  ) {
    throw new Error(
      `Post-write inventory mismatch: current=${String(current.entities.length)}, revisions=${String(current.revisions.length)}, links=${String(current.links.length)}.`,
    );
  }

  assertExactLegacyRows<RevisionSnapshot>(
    "Legacy revision",
    source.revisions,
    current.revisions,
    revisionIdentity,
  );
  assertExactLegacyRows<LinkSnapshot>(
    "Legacy link",
    source.links,
    current.links,
    (link) => link.id,
  );

  const sourceByIdentity = new Map(
    source.entities.map((entity) => [entityIdentity(entity), entity]),
  );
  const currentByIdentity = new Map(
    current.entities.map((entity) => [entityIdentity(entity), entity]),
  );
  const revisionsByIdentity = new Map(
    current.revisions.map((revision) => [revisionIdentity(revision), revision]),
  );
  for (const entity of plan.entities) {
    const identity = `${entity.entityType}:${entity.entityId}`;
    const before = sourceByIdentity.get(identity);
    const after = currentByIdentity.get(identity);
    if (before === undefined || after === undefined) {
      throw new Error(`${identity} is missing from post-write verification.`);
    }
    assertEntityAfter(before, entity, after);
    assertRevisionAfter(revisionsByIdentity, {
      entityType: entity.entityType,
      entityId: entity.entityId,
      revision: entity.revision,
      workspaceId: entity.workspaceId,
      projectId: entity.projectId,
      documentSha256: entity.documentSha256,
    });
  }
  for (const rule of plan.rules) {
    const currentRule = currentByIdentity.get(`rule:${rule.entityId}`);
    if (currentRule === undefined) throw new Error(`${rule.key} is missing after insert.`);
    assertRuleAfter(rule, currentRule);
    assertRevisionAfter(revisionsByIdentity, {
      entityType: "rule",
      entityId: rule.entityId,
      revision: rule.revision,
      workspaceId: rule.workspaceId,
      projectId: rule.projectId,
      documentSha256: rule.documentSha256,
    });
  }
  if (current.entities.some((entity) => entity.entity_type === "milestone")) {
    throw new Error("Baseline migration unexpectedly created a Milestone.");
  }

  const sourceProjectById = new Map(source.projects.map((project) => [project.id, project]));
  const currentProjectById = new Map(current.projects.map((project) => [project.id, project]));
  for (const counters of plan.counters) {
    const before = sourceProjectById.get(counters.projectId);
    const after = currentProjectById.get(counters.projectId);
    if (before === undefined || after === undefined) {
      throw new Error(`Project ${counters.projectId} is missing after apply.`);
    }
    assertProjectAfter(before, counters, after);
  }

  const parseFailures: string[] = [];
  for (const entity of current.entities) {
    const parsed = parseDocument(entity.document, { source: "store" });
    if (!parsed.ok) {
      parseFailures.push(
        ...parsed.issues.map(
          (issue) => `${entity.entity_type}:${entity.key}:${issue.path}:${issue.message}`,
        ),
      );
    }
  }
  if (parseFailures.length > 0) {
    throw new Error(`Post-write v2 documents failed parsing:\n${parseFailures.join("\n")}`);
  }

  return {
    database_capabilities: current.capabilities,
    current_entities: current.entities.length,
    revisions: current.revisions.length,
    links: current.links.length,
    parsed_current_documents: current.entities.length,
    entity_baselines_verified: plan.entities.length,
    rules_and_legacy_round_trips_verified: plan.rules.length,
    migration_revision_rows_verified: plan.entities.length + plan.rules.length,
    unscheduled_streams_verified: unscheduledStreams,
    legacy_revision_rows_verified: source.revisions.length,
    legacy_links_verified: source.links.length,
    project_counters_verified: plan.counters.length,
    current_documents_sha256: currentDocumentAudit(current.entities),
    revision_rows_sha256: rowAudit(current.revisions, revisionIdentity),
    link_rows_sha256: rowAudit(current.links, (link) => link.id),
  };
};

const statusChanges = (source: DatabaseSnapshot, plan: V2MigrationPlan) => {
  const sourceByIdentity = new Map(
    source.entities.map((entity) => [entityIdentity(entity), entity]),
  );
  return plan.entities.flatMap((entity) => {
    const before = sourceByIdentity.get(`${entity.entityType}:${entity.entityId}`);
    return before !== undefined && before.status !== entity.status
      ? [
          {
            entity_id: entity.entityId,
            legacy_key: entity.legacyKey,
            key: entity.key,
            from: before.status,
            to: entity.status,
          },
        ]
      : [];
  });
};

/**
 * Applies the reviewed baseline inside the caller's explicit transaction.
 *
 * Call this only from `database.transaction(callback,
 * V2_MIGRATION_TRANSACTION)`. Runtime guards reject a wrong isolation/access
 * mode; the table locks then freeze all source rows before the authoritative
 * snapshot is read. Any thrown verification error rolls the caller's entire
 * transaction back.
 */
export async function applyV2Migration(
  transaction: SnapshotExecutor,
): Promise<V2MigrationManifest> {
  await assertSerializableTransaction(transaction);
  assertCapabilities(await readCapabilities(transaction));
  await lockMigrationTables(transaction);

  const source = await readDatabaseSnapshot(transaction);
  await assertUnscheduledBaselineStreams(transaction);
  assertCapabilities(source.capabilities);
  const preflight = buildV2PreflightReport(source);
  assertReviewedSource(source, preflight.projects);
  assertRelationshipAllowlist(source.links);
  const plan = buildV2MigrationPlan(source, preflight);
  assertPlan(source, preflight.projects, plan);

  const appliedAtRow = await requireSingleRow(
    transaction,
    sql`select transaction_timestamp() as applied_at`,
    "Migration timestamp read",
  );
  const appliedAt = timestampValue(appliedAtRow, "applied_at");
  await writePlan(transaction, source, plan);

  const current = await readDatabaseSnapshot(transaction);
  const unscheduledStreams = await assertUnscheduledBaselineStreams(transaction);
  const verification = verifyAppliedPlan(source, current, plan, unscheduledStreams);
  const changes = statusChanges(source, plan);
  if (
    changes.length !== 1 ||
    changes[0]?.legacy_key !== "STR-46" ||
    changes[0].from !== "ready" ||
    changes[0].to !== "planned"
  ) {
    throw new Error("Post-write status changes differ from the reviewed STR-46 demotion.");
  }

  return {
    manifest_version: "zpecs.v2.apply.manifest.v1",
    plan_version: plan.planVersion,
    writes_performed: true,
    applied_at: appliedAt,
    actor: MIGRATION_ACTOR,
    change_reason: MIGRATION_CHANGE_REASON,
    source: {
      projects: source.projects.length,
      current_entities: source.entities.length,
      revisions: source.revisions.length,
      links: source.links.length,
      reviewed_project_audits: REVIEWED_SOURCE,
    },
    applied: {
      entity_baselines: plan.entities.length,
      rules: plan.rules.length,
      rule_mappings: plan.rules.map((rule) => ({
        legacy_id: rule.legacyId,
        legacy_content_sha256: rule.legacyContentSha256,
        key: rule.key,
        entity_id: rule.entityId,
        revision: rule.revision,
      })),
      revision_rows_added: plan.entities.length + plan.rules.length,
      project_counters_updated: plan.counters.length,
      resolutions: plan.resolutions,
      status_changes: changes,
    },
    verification,
    decisions: plan.decisions,
  };
}
