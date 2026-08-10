import type { WorkspaceScope } from "../auth/workspaceScope";
import type { VersionedEntityType } from "../enums";
import { parseVersionedKey } from "../keys";
import { epicRepository } from "../repository/epic";
import { listContextRepository } from "../repository/listContext";
import { milestoneRepository } from "../repository/milestone";
import { ruleRepository } from "../repository/rule";
import { streamRepository } from "../repository/stream";
import { taskRepository } from "../repository/task";
import { type Project, workspaceRepository } from "../repository/workspace";

/**
 * Turning the two things an agent can name — a project, and an entity key — into
 * rows, in one place.
 *
 * ## Why a key needs a project to be unambiguous
 *
 * A key is unique **per project**, not per workspace: `E-1` exists in every
 * project that has one epic. A compact indexed candidate query resolves a bare
 * key across the workspace, and two answers are a refusal rather than a guess —
 * writing to the wrong project is worse than being told to be specific.
 *
 * `resolveProject` is the missing half. Every tool that takes a key takes an
 * optional project alongside it, and `resolveEntityByKey` narrows the search to
 * that one project when it is given. `ambiguous` carries the names of the projects
 * that answered, so the remediation is a value the agent can paste back.
 *
 * ## Why a project is named by its `name`
 *
 * A project row has no key and no slug. It has an `id` and a `name`, and the name
 * is unique per workspace (`project_workspace_name_uniq`), so the name is the
 * human-facing identifier and the only one an agent is ever told. An id is
 * accepted as well; `workspaceRepository.findProjectByRef` owns that distinction.
 */

/** A resolved entity, in the one shape every read path here needs. */
export type EntityReference = {
  readonly entity: VersionedEntityType;
  readonly id: string;
  readonly key: string;
  readonly projectId: string;
  readonly title: string;
  readonly status: string;
  readonly revision: number;
  /** The parent stream's id — tasks only, and what the §7 bundle keys off. */
  readonly streamId: string | null;
  /** The parent epic's id — streams only. */
  readonly epicId: string | null;
  /** Canonical advisory order — milestones only. */
  readonly roadmapOrder: number | null;
  /** Optional roadmap assignment — streams only. */
  readonly milestoneId: string | null;
  readonly roadmapRank: number | null;
  readonly document: Record<string, unknown>;
};

export type ProjectResolution =
  | { readonly ok: true; readonly project: Project }
  | { readonly ok: false; readonly reason: "unknown_project"; readonly ref: string };

type ProjectReference = Pick<Project, "id" | "name">;

export type EntityResolution =
  /** `project` comes back too: resolving the key had to identify it anyway, and the
   * caller needs its name both to report where the entity lives and to hand the
   * agent the qualifier for its next call. */
  | { readonly ok: true; readonly reference: EntityReference; readonly project: ProjectReference }
  /** `key` is not shaped like a key at all, so no lookup was attempted. */
  | { readonly ok: false; readonly reason: "not_a_key"; readonly key: string }
  | { readonly ok: false; readonly reason: "unknown_project"; readonly ref: string }
  | { readonly ok: false; readonly reason: "not_found"; readonly key: string }
  | {
      readonly ok: false;
      readonly reason: "ambiguous";
      readonly key: string;
      /** The names to choose between, in the order `listProjects` returns them. */
      readonly projectNames: readonly string[];
    };

async function resolveProject(scope: WorkspaceScope, ref: string): Promise<ProjectResolution> {
  const project = await workspaceRepository.findProjectByRef(scope, ref);
  return project ? { ok: true, project } : { ok: false, reason: "unknown_project", ref };
}

/**
 * The entity one key names, optionally narrowed to one project.
 *
 * The entity *kind* comes from the key's prefix (`parseVersionedKey`), not from a
 * lookup, so a key is routed to exactly one repository and a mistyped key fails
 * as a missing key rather than as three misses.
 */
async function resolveEntityByKey(
  scope: WorkspaceScope,
  input: { readonly key: string; readonly project?: string | undefined },
): Promise<EntityResolution> {
  const parsed = parseVersionedKey(input.key);
  if (!parsed) {
    return { ok: false, reason: "not_a_key", key: input.key };
  }

  if (input.project !== undefined) {
    const resolved = await resolveProject(scope, input.project);
    if (!resolved.ok) {
      return resolved;
    }
    const reference = await findByKey(scope, parsed.entity, resolved.project.id, input.key);
    return reference === null
      ? { ok: false, reason: "not_found", key: input.key }
      : { ok: true, reference, project: resolved.project };
  }

  // A bare key is resolved by one compact candidate query, regardless of how
  // many projects the workspace contains. Only the unique hit loads document
  // JSON, keeping this path at two queries instead of one query per project.
  const hits = await listContextRepository.findByKey(scope, {
    entity: parsed.entity,
    key: input.key,
  });
  const [only, ...rest] = hits;
  if (!only) {
    return { ok: false, reason: "not_found", key: input.key };
  }
  if (rest.length > 0) {
    return {
      ok: false,
      reason: "ambiguous",
      key: input.key,
      projectNames: hits.map((hit) => hit.project),
    };
  }
  const reference = await findByKey(scope, parsed.entity, only.projectId, input.key);
  return reference === null
    ? { ok: false, reason: "not_found", key: input.key }
    : {
        ok: true,
        reference,
        project: { id: only.projectId, name: only.project },
      };
}

async function findByKey(
  scope: WorkspaceScope,
  entity: VersionedEntityType,
  projectId: string,
  key: string,
): Promise<EntityReference | null> {
  switch (entity) {
    case "epic": {
      const row = await epicRepository.findByKey(scope, { projectId, key });
      return row === null
        ? null
        : {
            ...common(row),
            entity,
            streamId: null,
            epicId: null,
            roadmapOrder: null,
            milestoneId: null,
            roadmapRank: null,
          };
    }
    case "stream": {
      const row = await streamRepository.findByKey(scope, { projectId, key });
      return row === null
        ? null
        : {
            ...common(row),
            entity,
            streamId: null,
            epicId: row.epicId,
            roadmapOrder: null,
            milestoneId: row.milestoneId,
            roadmapRank: row.roadmapRank,
          };
    }
    case "task": {
      const row = await taskRepository.findByKey(scope, { projectId, key });
      return row === null
        ? null
        : {
            ...common(row),
            entity,
            streamId: row.streamId,
            epicId: null,
            roadmapOrder: null,
            milestoneId: null,
            roadmapRank: null,
          };
    }
    case "milestone": {
      const row = await milestoneRepository.findByKey(scope, { projectId, key });
      return row === null
        ? null
        : {
            ...common(row),
            entity,
            streamId: null,
            epicId: null,
            roadmapOrder: row.roadmapOrder,
            milestoneId: null,
            roadmapRank: null,
          };
    }
    case "rule": {
      const row = await ruleRepository.findByKey(scope, { projectId, key });
      return row === null
        ? null
        : {
            ...common(row),
            entity,
            streamId: null,
            epicId: null,
            roadmapOrder: null,
            milestoneId: null,
            roadmapRank: null,
          };
    }
  }
}

/** The columns all versioned rows share, so each branch above states only its own. */
const common = (row: {
  id: string;
  key: string;
  projectId: string;
  title: string;
  status: string;
  revision: number;
  document: Record<string, unknown>;
}) => ({
  id: row.id,
  key: row.key,
  projectId: row.projectId,
  title: row.title,
  status: row.status,
  revision: row.revision,
  document: row.document,
});

export const referenceService = { resolveProject, resolveEntityByKey };
