import { and, asc, count, countDistinct, eq, ilike, inArray, sql } from "drizzle-orm";
import { db } from "../../integration/drizzle/client";
import { projectFragment } from "../../integration/drizzle/schema/projectFragment";
import { task } from "../../integration/drizzle/schema/task";
import type { WorkspaceScope } from "../auth/workspaceScope";
import type { VersionedEntityType } from "../enums";
import { asRecord, asText } from "../service/documentValue";
import { fragmentText, readFragments, type SectionId } from "../service/specFragment";
import type { DbExecutor, DbTransaction } from "./entity";

export type FragmentProjectionRow = typeof projectFragment.$inferSelect;

export type FragmentProjectionFilter = {
  readonly offset: number;
  readonly limit: number;
  readonly section?: SectionId;
  readonly owner?: string;
  readonly q?: string;
};

export type FragmentProjectionPage = {
  readonly rows: readonly FragmentProjectionRow[];
  readonly total: number;
  readonly ownerCount: number;
  readonly sectionCounts: readonly { readonly section: string; readonly count: number }[];
};

const PAGE_ENTITY_ORDER: Readonly<Record<VersionedEntityType, number>> = {
  epic: 0,
  stream: 1,
  task: 2,
  milestone: 3,
  rule: 4,
};

const filterWhere = (
  scope: WorkspaceScope,
  projectId: string,
  filter: Pick<FragmentProjectionFilter, "section" | "owner" | "q">,
) => {
  const needle = filter.q?.trim();
  return and(
    eq(projectFragment.workspaceId, scope),
    eq(projectFragment.projectId, projectId),
    filter.section ? eq(projectFragment.section, filter.section) : undefined,
    filter.owner ? eq(projectFragment.ownerKey, filter.owner) : undefined,
    needle ? ilike(projectFragment.searchText, `%${needle}%`) : undefined,
  );
};

/** Bounded page plus compact aggregate metadata; no document JSON crosses this boundary. */
async function loadPage(
  scope: WorkspaceScope,
  projectId: string,
  filter: FragmentProjectionFilter,
  executor: DbExecutor = db,
): Promise<FragmentProjectionPage> {
  const where = filterWhere(scope, projectId, filter);
  const unfiltered = and(
    eq(projectFragment.workspaceId, scope),
    eq(projectFragment.projectId, projectId),
  );
  const [rows, totals, sections] = await Promise.all([
    executor
      .select()
      .from(projectFragment)
      .where(where)
      .orderBy(
        asc(projectFragment.ownerKindOrder),
        asc(projectFragment.ownerSequence),
        asc(projectFragment.position),
      )
      .offset(filter.offset)
      .limit(filter.limit),
    executor
      .select({
        total: count(),
        ownerCount: countDistinct(projectFragment.ownerKey),
      })
      .from(projectFragment)
      .where(where),
    executor
      .select({ section: projectFragment.section, count: count() })
      .from(projectFragment)
      .where(unfiltered)
      .groupBy(projectFragment.section),
  ]);

  return {
    rows,
    total: totals[0]?.total ?? 0,
    ownerCount: totals[0]?.ownerCount ?? 0,
    sectionCounts: sections,
  };
}

async function countByProject(
  scope: WorkspaceScope,
  projectId: string,
  executor: DbExecutor = db,
): Promise<number> {
  const [row] = await executor
    .select({ count: count() })
    .from(projectFragment)
    .where(and(eq(projectFragment.workspaceId, scope), eq(projectFragment.projectId, projectId)));
  return row?.count ?? 0;
}

/** Replaces one owner's derived fragments after its authoritative document changes. */
export async function replaceOwnerFragments(
  scope: WorkspaceScope,
  tx: DbTransaction,
  input: {
    readonly entityType: VersionedEntityType;
    readonly entityId: string;
    readonly projectId: string;
    readonly document: Record<string, unknown>;
  },
): Promise<void> {
  await tx
    .delete(projectFragment)
    .where(
      and(
        eq(projectFragment.workspaceId, scope),
        eq(projectFragment.ownerType, input.entityType),
        eq(projectFragment.ownerId, input.entityId),
      ),
    );

  // Rules are searchable entities but own no addressable specification fragments.
  if (input.entityType === "rule") return;
  const meta = asRecord(input.document.meta);
  const ownerKey = asText(meta.key);
  const ownerTitle = asText(meta.title);
  const fragments = readFragments(ownerKey, input.document);
  if (fragments.length === 0) return;

  const backlinksByLocalId = new Map<string, { readonly id: string; readonly key: string }[]>();
  if (input.entityType === "stream") {
    const tasks = await tx
      .select({ id: task.id, key: task.key, document: task.document })
      .from(task)
      .where(and(eq(task.workspaceId, scope), eq(task.streamId, input.entityId)));
    for (const row of tasks) {
      const implementsValue = asRecord(asRecord(row.document.content).implements);
      for (const value of Object.values(implementsValue)) {
        if (!Array.isArray(value)) continue;
        for (const id of value) {
          if (typeof id !== "string" || id.length === 0) continue;
          const bucket = backlinksByLocalId.get(id);
          if (bucket) bucket.push({ id: row.id, key: row.key });
          else backlinksByLocalId.set(id, [{ id: row.id, key: row.key }]);
        }
      }
    }
  }

  await tx.insert(projectFragment).values(
    fragments.map((fragment, position) => {
      const anchor = `${ownerKey}#${fragment.id}`;
      const text = fragmentText(fragment);
      return {
        workspaceId: scope,
        projectId: input.projectId,
        ownerType: input.entityType,
        ownerId: input.entityId,
        ownerKey,
        ownerTitle,
        ownerKindOrder: PAGE_ENTITY_ORDER[input.entityType],
        ownerSequence: Number.parseInt(ownerKey.split("-")[1] ?? "0", 10),
        section: fragment.section,
        anchor,
        position,
        fragment,
        fragmentText: text,
        searchText: `${anchor} ${text}`,
        backlinks: backlinksByLocalId.get(fragment.id) ?? [],
      };
    }),
  );
}

/**
 * Removes this Task's old backlink contribution and writes its current targets.
 *
 * The two statements deliberately run for every Task revision. That makes moving a
 * Task, clearing `implements`, or changing a target the same operation as adding a
 * backlink and prevents projection drift from special-case write paths.
 */
export async function replaceTaskBacklinks(
  scope: WorkspaceScope,
  tx: DbTransaction,
  input: {
    readonly taskId: string;
    readonly taskKey: string;
    readonly projectId: string;
    readonly document: Record<string, unknown>;
  },
): Promise<void> {
  await tx.execute(sql`
    update ${projectFragment}
       set backlinks = coalesce((
         select jsonb_agg(item)
           from jsonb_array_elements(${projectFragment.backlinks}) as item
          where item ->> 'id' <> ${input.taskId}
       ), '[]'::jsonb)
     where ${projectFragment.workspaceId} = ${scope}
       and ${projectFragment.backlinks} @> ${JSON.stringify([{ id: input.taskId }])}::jsonb`);

  const parentStreamId = asText(asRecord(input.document.links).parent_stream_id);
  if (parentStreamId.length === 0) return;
  const implementsValue = asRecord(asRecord(input.document.content).implements);
  const targetIds = new Set<string>();
  for (const value of Object.values(implementsValue)) {
    if (!Array.isArray(value)) continue;
    for (const id of value) {
      if (typeof id === "string" && id.length > 0) targetIds.add(id);
    }
  }
  if (targetIds.size === 0) return;

  await tx.execute(sql`
    update ${projectFragment}
       set backlinks = ${projectFragment.backlinks} ||
         jsonb_build_array(jsonb_build_object('id', ${input.taskId}::text, 'key', ${input.taskKey}::text))
     where ${projectFragment.workspaceId} = ${scope}
       and ${projectFragment.projectId} = ${input.projectId}
       and ${projectFragment.ownerType} = 'stream'
       and ${projectFragment.ownerId} = ${parentStreamId}
       and ${inArray(sql<string>`split_part(${projectFragment.anchor}, '#', 2)`, [...targetIds])}
       and not (${projectFragment.backlinks} @> ${JSON.stringify([{ id: input.taskId }])}::jsonb)`);
}

/** Re-homes every projected descendant selected by stable current entity ids. */
export async function moveHierarchyFragments(
  scope: WorkspaceScope,
  tx: DbTransaction,
  input: {
    readonly projectId: string;
    readonly previousProjectId: string;
    readonly rootType: "epic" | "stream";
    readonly rootId: string;
  },
): Promise<void> {
  const descendants =
    input.rootType === "epic"
      ? sql`(
          (${projectFragment.ownerType} = 'epic' and ${projectFragment.ownerId} = ${input.rootId})
          or (${projectFragment.ownerType} = 'stream' and exists (
            select 1 from stream
             where stream.workspace_id = ${scope}
               and stream.id = ${projectFragment.ownerId}
               and stream.epic_id = ${input.rootId}
          ))
          or (${projectFragment.ownerType} = 'task' and exists (
            select 1 from task
            join stream on stream.id = task.stream_id and stream.workspace_id = ${scope}
             where task.workspace_id = ${scope}
               and task.id = ${projectFragment.ownerId}
               and stream.epic_id = ${input.rootId}
          ))
        )`
      : sql`(
          (${projectFragment.ownerType} = 'stream' and ${projectFragment.ownerId} = ${input.rootId})
          or (${projectFragment.ownerType} = 'task' and exists (
            select 1 from task
             where task.workspace_id = ${scope}
               and task.id = ${projectFragment.ownerId}
               and task.stream_id = ${input.rootId}
          ))
        )`;
  await tx
    .update(projectFragment)
    .set({ projectId: input.projectId })
    .where(
      and(
        eq(projectFragment.workspaceId, scope),
        eq(projectFragment.projectId, input.previousProjectId),
        descendants,
      ),
    );
}

export const projectFragmentRepository = { loadPage, countByProject };
