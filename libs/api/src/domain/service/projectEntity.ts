import type { WorkspaceScope } from "../auth/workspaceScope";
import type { VersionedEntityType } from "../enums";
import { parseVersionedKey } from "../keys";
import { epicRepository } from "../repository/epic";
import { milestoneRepository } from "../repository/milestone";
import { ruleRepository } from "../repository/rule";
import { streamRepository } from "../repository/stream";
import { taskRepository } from "../repository/task";

/**
 * One entity of one project, by its public key, with its document whole.
 *
 * The aggregate carries a pruned copy of every document — see `readProjection.ts` —
 * because it is fetched on every navigation and most of what a Task holds is read
 * by nothing. This is the other half of that trade: a screen that is already about
 * one entity, and wants a section the aggregate drops, asks for that entity.
 *
 * The key's prefix decides which table is read, so this is one query and never a
 * search across five. A key whose prefix names no entity kind resolves to `null`
 * rather than fanning out — `X-1` is not a lookup, it is a typo.
 */

export type ProjectEntityDocument = {
  readonly entityType: VersionedEntityType;
  readonly key: string;
  readonly title: string;
  readonly revision: number;
  readonly document: Record<string, unknown>;
};

export async function findProjectEntity(
  scope: WorkspaceScope,
  projectId: string,
  key: string,
): Promise<ProjectEntityDocument | null> {
  const parsed = parseVersionedKey(key);
  if (!parsed) return null;

  const row = await findRow(scope, projectId, parsed.entity, key);
  if (!row) return null;

  return {
    entityType: parsed.entity,
    key: row.key,
    title: row.title,
    revision: row.revision,
    document: row.document,
  };
}

type EntityRow = {
  readonly key: string;
  readonly title: string;
  readonly revision: number;
  readonly document: Record<string, unknown>;
};

/** Reads the one table the key names. The tenant filter stays the repository's. */
async function findRow(
  scope: WorkspaceScope,
  projectId: string,
  entity: VersionedEntityType,
  key: string,
): Promise<EntityRow | null> {
  const input = { projectId, key };
  switch (entity) {
    case "epic":
      return await epicRepository.findByKey(scope, input);
    case "stream":
      return await streamRepository.findByKey(scope, input);
    case "task":
      return await taskRepository.findByKey(scope, input);
    case "rule":
      return await ruleRepository.findByKey(scope, input);
    case "milestone":
      return await milestoneRepository.findByKey(scope, input);
  }
}
