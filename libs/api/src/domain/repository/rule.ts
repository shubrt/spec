import { type SQL, and, asc, eq, inArray, or, sql } from "drizzle-orm";
import { DomainError } from "../../_/errors";
import { db } from "../../integration/drizzle/client";
import { executeRows } from "../../integration/drizzle/executeRows";
import { entityRevision } from "../../integration/drizzle/schema/entityRevision";
import { epic } from "../../integration/drizzle/schema/epic";
import { rule } from "../../integration/drizzle/schema/rule";
import { stream } from "../../integration/drizzle/schema/stream";
import { task } from "../../integration/drizzle/schema/task";
import type { WorkspaceScope } from "../auth/workspaceScope";
import { RULE_STATUS, type RuleStatus } from "../enums";
import {
  type DbExecutor,
  type DbTransaction,
  FIRST_REVISION,
  type RevisionAuthor,
  type WriteResult,
  issueKey,
  recordRevision,
  stampServerOwnedMeta,
} from "./entity";

/**
 * The canonical Rule aggregate. Applications of a Rule live in other entities'
 * documents; the definition, lifecycle and revision history live here exactly
 * once.
 */
export type Rule = typeof rule.$inferSelect;

export type RuleRevisionPin = { readonly key: string; readonly revision: number };

export type RuleRevisionTarget = RuleRevisionPin & { readonly entityId: string };

export type RuleRevisionSnapshot = RuleRevisionPin & {
  readonly document: Record<string, unknown>;
};

export type RuleConsumer = {
  readonly entity: "epic" | "stream" | "task";
  readonly key: string;
  readonly title: string;
  readonly status: string;
  readonly source: "rule_application" | "task_constraint" | "acceptance_criterion" | "task_pin";
  readonly localId: string | null;
  readonly appliesWhen: string | null;
  readonly application: string | null;
  readonly pinnedRevision: number | null;
};

export type InsertRuleInput = RevisionAuthor & {
  readonly projectId: string;
  readonly document: Record<string, unknown>;
  readonly summary?: string | null;
};

export type UpdateRuleInput = RevisionAuthor & {
  readonly id: string;
  readonly expectedRevision: number;
  readonly document: Record<string, unknown>;
  /** Omitted leaves the stored summary alone; `null` clears it. */
  readonly summary?: string | null;
};

export type DeprecateRuleInput = RevisionAuthor & {
  readonly id: string;
  readonly expectedRevision: number;
};

export type DeleteRuleInput = {
  readonly id: string;
  readonly expectedRevision: number;
};

const DEPRECATED: RuleStatus = "deprecated";

async function findById(
  scope: WorkspaceScope,
  id: string,
  executor: DbExecutor = db,
): Promise<Rule | null> {
  const [row] = await executor
    .select()
    .from(rule)
    .where(and(eq(rule.workspaceId, scope), eq(rule.id, id)))
    .limit(1);
  return row ?? null;
}

async function findByKey(
  scope: WorkspaceScope,
  input: { readonly projectId: string; readonly key: string },
  executor: DbExecutor = db,
): Promise<Rule | null> {
  const [row] = await executor
    .select()
    .from(rule)
    .where(
      and(
        eq(rule.workspaceId, scope),
        eq(rule.projectId, input.projectId),
        eq(rule.key, input.key),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Every canonical Rule in one project, in one fixed-cost query. */
async function listByProject(
  scope: WorkspaceScope,
  projectId: string,
  executor: DbExecutor = db,
): Promise<Rule[]> {
  return await executor
    .select()
    .from(rule)
    .where(and(eq(rule.workspaceId, scope), eq(rule.projectId, projectId)))
    .orderBy(asc(rule.createdAt), asc(rule.key));
}

/** Current definitions for many R-keys in one project-scoped query. */
async function listByKeys(
  scope: WorkspaceScope,
  input: { readonly projectId: string; readonly keys: readonly string[] },
  executor: DbExecutor = db,
): Promise<Rule[]> {
  if (input.keys.length === 0) return [];
  return await executor
    .select()
    .from(rule)
    .where(
      and(
        eq(rule.workspaceId, scope),
        eq(rule.projectId, input.projectId),
        inArray(rule.key, [...new Set(input.keys)]),
      ),
    )
    .orderBy(asc(rule.key));
}

/** Exact historical Rule documents for terminal Task trace pins, in one query. */
async function listRevisionSnapshots(
  scope: WorkspaceScope,
  input: { readonly projectId: string; readonly targets: readonly RuleRevisionTarget[] },
  executor: DbExecutor = db,
): Promise<RuleRevisionSnapshot[]> {
  if (input.targets.length === 0) return [];
  const wanted = or(
    ...input.targets.map((target) =>
      and(
        eq(entityRevision.entityId, target.entityId),
        eq(entityRevision.revision, target.revision),
      ),
    ),
  );
  const rows = await executor
    .select({
      entityId: entityRevision.entityId,
      revision: entityRevision.revision,
      document: entityRevision.document,
    })
    .from(entityRevision)
    .where(
      and(
        eq(entityRevision.workspaceId, scope),
        eq(entityRevision.projectId, input.projectId),
        eq(entityRevision.entityType, "rule"),
        wanted,
      ),
    );
  const keyByTarget = new Map(
    input.targets.map((target) => [`${target.entityId}:${String(target.revision)}`, target.key]),
  );
  return rows.flatMap((row) => {
    const key = keyByTarget.get(`${row.entityId}:${String(row.revision)}`);
    return key === undefined ? [] : [{ key, revision: row.revision, document: row.document }];
  });
}

const jsonArray = (value: SQL): SQL =>
  sql`case when jsonb_typeof(${value}) = 'array' then ${value} else '[]'::jsonb end`;

type RawRuleConsumer = {
  readonly entity: unknown;
  readonly key: string;
  readonly title: string;
  readonly status: string;
  readonly source: unknown;
  readonly local_id: string | null;
  readonly applies_when: string | null;
  readonly application_note: string | null;
  readonly pinned_revision: number | null;
};

const isConsumerEntity = (value: unknown): value is RuleConsumer["entity"] =>
  value === "epic" || value === "stream" || value === "task";

const isConsumerSource = (value: unknown): value is RuleConsumer["source"] =>
  value === "rule_application" ||
  value === "task_constraint" ||
  value === "acceptance_criterion" ||
  value === "task_pin";

/**
 * Direct current consumers of one canonical Rule. The five JSON traversals are
 * branches of one statement; consumer count never changes query count and no
 * document JSON crosses the repository boundary.
 */
async function listConsumers(
  scope: WorkspaceScope,
  input: { readonly projectId: string; readonly ruleKey: string },
  executor: DbExecutor = db,
): Promise<RuleConsumer[]> {
  const epicApplications = jsonArray(sql`${epic.document} -> 'content' -> 'rule_applications'`);
  const streamApplications = jsonArray(sql`${stream.document} -> 'content' -> 'rule_applications'`);
  const taskConstraints = jsonArray(
    sql`${task.document} -> 'content' -> 'constrained_by_rule_keys'`,
  );
  const taskPins = jsonArray(sql`${task.document} -> 'execution' -> 'rule_revisions_used'`);
  const acceptanceCriteria = jsonArray(
    sql`${stream.document} -> 'content' -> 'acceptance_criteria'`,
  );
  const criterionRules = (criterion: SQL): SQL =>
    jsonArray(sql`${criterion} -> 'verifies' -> 'rule_keys'`);

  const statement = sql`
    select consumer.entity, consumer.key, consumer.title, consumer.status,
           consumer.source, consumer.local_id, consumer.applies_when,
           consumer.application_note, consumer.pinned_revision
      from (
        select 'epic'::text as entity, ${epic.key} as key, ${epic.title} as title,
               ${epic.status} as status, 'rule_application'::text as source,
               application ->> 'id' as local_id,
               application ->> 'applies_when' as applies_when,
               application ->> 'application' as application_note,
               null::integer as pinned_revision
          from ${epic}
         cross join lateral jsonb_array_elements(${epicApplications}) as application
         where ${epic.workspaceId} = ${scope}
           and ${epic.projectId} = ${input.projectId}
           and application ->> 'rule_key' = ${input.ruleKey}
        union all
        select 'stream'::text as entity, ${stream.key} as key, ${stream.title} as title,
               ${stream.status} as status, 'rule_application'::text as source,
               application ->> 'id' as local_id,
               application ->> 'applies_when' as applies_when,
               application ->> 'application' as application_note,
               null::integer as pinned_revision
          from ${stream}
         cross join lateral jsonb_array_elements(${streamApplications}) as application
         where ${stream.workspaceId} = ${scope}
           and ${stream.projectId} = ${input.projectId}
           and application ->> 'rule_key' = ${input.ruleKey}
        union all
        select 'task'::text as entity, ${task.key} as key, ${task.title} as title,
               ${task.status} as status, 'task_constraint'::text as source,
               null::text as local_id, null::text as applies_when,
               null::text as application_note, null::integer as pinned_revision
          from ${task}
         cross join lateral jsonb_array_elements_text(${taskConstraints}) as constrained(rule_key)
         where ${task.workspaceId} = ${scope}
           and ${task.projectId} = ${input.projectId}
           and constrained.rule_key = ${input.ruleKey}
        union all
        select 'stream'::text as entity, ${stream.key} as key, ${stream.title} as title,
               ${stream.status} as status, 'acceptance_criterion'::text as source,
               criterion ->> 'id' as local_id, null::text as applies_when,
               null::text as application_note, null::integer as pinned_revision
          from ${stream}
         cross join lateral jsonb_array_elements(${acceptanceCriteria}) as criterion
         cross join lateral jsonb_array_elements_text(${criterionRules(sql`criterion`)}) as verified(rule_key)
         where ${stream.workspaceId} = ${scope}
           and ${stream.projectId} = ${input.projectId}
           and verified.rule_key = ${input.ruleKey}
        union all
        select 'task'::text as entity, ${task.key} as key, ${task.title} as title,
               ${task.status} as status, 'task_pin'::text as source,
               null::text as local_id, null::text as applies_when,
               null::text as application_note,
               case when pin ->> 'revision' ~ '^[1-9][0-9]*$'
                    then (pin ->> 'revision')::integer else null end as pinned_revision
          from ${task}
         cross join lateral jsonb_array_elements(${taskPins}) as pin
         where ${task.workspaceId} = ${scope}
           and ${task.projectId} = ${input.projectId}
           and pin ->> 'rule_key' = ${input.ruleKey}
      ) as consumer
     order by consumer.entity, consumer.key, consumer.source, consumer.local_id nulls last`;

  const rows = await executeRows<RawRuleConsumer>(executor, statement);
  return rows.map((row) => {
    if (!isConsumerEntity(row.entity) || !isConsumerSource(row.source)) {
      throw new Error(`Rule consumer query returned an invalid discriminator.`);
    }
    return {
      entity: row.entity,
      key: row.key,
      title: row.title,
      status: row.status,
      source: row.source,
      localId: row.local_id ?? null,
      appliesWhen: row.applies_when ?? null,
      application: row.application_note ?? null,
      pinnedRevision: row.pinned_revision ?? null,
    };
  });
}

async function insert(
  scope: WorkspaceScope,
  input: InsertRuleInput,
  tx: DbTransaction,
): Promise<WriteResult<Rule>> {
  const key = await issueKey(scope, tx, { entity: "rule", projectId: input.projectId });
  if (key === null) {
    return { ok: false, reason: "not_found" };
  }
  const id = crypto.randomUUID();
  const stamped = stampServerOwnedMeta(input.document, {
    id,
    key,
    revision: FIRST_REVISION,
    statuses: RULE_STATUS,
  });
  const [row] = await tx
    .insert(rule)
    .values({
      id,
      workspaceId: scope,
      projectId: input.projectId,
      key,
      status: stamped.status,
      revision: FIRST_REVISION,
      title: stamped.title,
      summary: input.summary ?? null,
      document: stamped.document,
    })
    .returning();
  if (!row) {
    throw new DomainError("insert_returned_no_row", `Insert of rule ${key} returned no row.`);
  }
  await recordRevision(scope, tx, {
    entityType: "rule",
    entityId: row.id,
    projectId: row.projectId,
    revision: row.revision,
    document: row.document,
    changedBy: input.changedBy,
    changeReason: input.changeReason,
  });
  return { ok: true, row };
}

async function bumpRevision(
  scope: WorkspaceScope,
  input: UpdateRuleInput,
  tx: DbTransaction,
): Promise<WriteResult<Rule>> {
  const current = await findById(scope, input.id, tx);
  if (!current) {
    return { ok: false, reason: "not_found" };
  }
  return await writeRevision(scope, tx, current, input);
}

/**
 * Deprecation keeps a Rule addressable and does not rewrite its consumers. A
 * superseding relation, when present, is ordinary validated Rule content.
 */
async function deprecate(
  scope: WorkspaceScope,
  input: DeprecateRuleInput,
  tx: DbTransaction,
): Promise<WriteResult<Rule>> {
  const current = await findById(scope, input.id, tx);
  if (!current) {
    return { ok: false, reason: "not_found" };
  }
  return await writeRevision(scope, tx, current, {
    ...input,
    document: current.document,
    sections: { meta: { status: DEPRECATED } },
  });
}

/**
 * Low-level OCC delete. The domain service must reject it while any Rule
 * application or Rule relation still references this row.
 */
async function deleteRule(
  scope: WorkspaceScope,
  input: DeleteRuleInput,
  tx: DbTransaction,
): Promise<WriteResult<Rule>> {
  const [row] = await tx
    .delete(rule)
    .where(
      and(
        eq(rule.workspaceId, scope),
        eq(rule.id, input.id),
        eq(rule.revision, input.expectedRevision),
      ),
    )
    .returning();
  if (!row) {
    return await conflict(scope, input.id, tx);
  }
  return { ok: true, row };
}

async function conflict(
  scope: WorkspaceScope,
  id: string,
  tx: DbTransaction,
): Promise<WriteResult<Rule>> {
  const current = await findById(scope, id, tx);
  return current
    ? { ok: false, reason: "revision_conflict", current }
    : { ok: false, reason: "not_found" };
}

async function writeRevision(
  scope: WorkspaceScope,
  tx: DbTransaction,
  current: Rule,
  input: RevisionAuthor & {
    readonly expectedRevision: number;
    readonly document: Record<string, unknown>;
    readonly summary?: string | null;
    readonly sections?: Readonly<Record<string, Record<string, unknown>>>;
  },
): Promise<WriteResult<Rule>> {
  const revision = input.expectedRevision + 1;
  const stamped = stampServerOwnedMeta(input.document, {
    id: current.id,
    key: current.key,
    revision,
    statuses: RULE_STATUS,
    sections: input.sections,
  });
  const [row] = await tx
    .update(rule)
    .set({
      status: stamped.status,
      revision,
      title: stamped.title,
      document: stamped.document,
      ...(input.summary === undefined ? {} : { summary: input.summary }),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(rule.workspaceId, scope),
        eq(rule.id, current.id),
        eq(rule.revision, input.expectedRevision),
      ),
    )
    .returning();
  if (!row) {
    return await conflict(scope, current.id, tx);
  }
  await recordRevision(scope, tx, {
    entityType: "rule",
    entityId: row.id,
    projectId: row.projectId,
    revision: row.revision,
    document: row.document,
    changedBy: input.changedBy,
    changeReason: input.changeReason,
  });
  return { ok: true, row };
}

export const ruleRepository = {
  findById,
  findByKey,
  listByProject,
  listByKeys,
  listRevisionSnapshots,
  listConsumers,
  insert,
  bumpRevision,
  deprecate,
  delete: deleteRule,
};
