import { type SQL, and, asc, eq, exists, not, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { db } from "../../integration/drizzle/client";
import { entityRevision } from "../../integration/drizzle/schema/entityRevision";
import { entityRevisionSummary } from "../../integration/drizzle/schema/entityRevisionSummary";
import { epic } from "../../integration/drizzle/schema/epic";
import { milestone } from "../../integration/drizzle/schema/milestone";
import { project } from "../../integration/drizzle/schema/project";
import { rule } from "../../integration/drizzle/schema/rule";
import { stream } from "../../integration/drizzle/schema/stream";
import { task } from "../../integration/drizzle/schema/task";
import { workspace } from "../../integration/drizzle/schema/workspace";
import type { WorkspaceScope } from "../auth/workspaceScope";
import { projectNameSchema } from "../projectName";
import type { DbTransaction } from "./entity";

export type Workspace = typeof workspace.$inferSelect;
export type Project = typeof project.$inferSelect;

export type EnsureWorkspaceInput = {
  clerkOrgId: string;
  name: string;
  slug: string | null;
};

export type EnsureProjectResult = {
  status: "created" | "existing";
  project: Project;
};

export const workspaceRepository = {
  /**
   * One of two repository functions that deliberately take no `scope` first:
   * this one *creates* the scope. The other is the read-only Clerk-id lookup
   * used only by the admin bootstrap command. Everything else in this layer
   * receives a `WorkspaceScope` because a tenant already exists; `ensure` runs
   * before one does, from the `org_id` claim of a verified token.
   *
   * Just-in-time: the first authenticated request for an organization inserts
   * the row; later requests refresh `name`/`slug` from the token so a rename in
   * Clerk propagates without a webhook.
   */
  async ensure(input: EnsureWorkspaceInput): Promise<Workspace> {
    const [row] = await db
      .insert(workspace)
      .values(input)
      .onConflictDoUpdate({
        target: workspace.clerkOrgId,
        set: { name: input.name, slug: input.slug, updatedAt: new Date() },
      })
      .returning();
    if (!row) {
      throw new Error("workspace upsert returned no row");
    }
    return row;
  },

  /**
   * Resolves the local row for the admin bootstrap command.
   *
   * This is deliberately the repository's second unscoped operation: the
   * operator only has Clerk's organization id until this lookup produces the
   * local uuid from which a {@link WorkspaceScope} can be made. It is read-only
   * and is not exposed through an API handler.
   */
  async findByClerkOrgId(clerkOrgId: string): Promise<Workspace | null> {
    const [row] = await db
      .select()
      .from(workspace)
      .where(eq(workspace.clerkOrgId, clerkOrgId))
      .limit(1);
    return row ?? null;
  },

  /** The scope's own row. Returns null only if the workspace was deleted mid-session. */
  async find(scope: WorkspaceScope): Promise<Workspace | null> {
    const [row] = await db.select().from(workspace).where(eq(workspace.id, scope)).limit(1);
    return row ?? null;
  },

  /**
   * Serializes all entity change sets inside one workspace.
   *
   * Cross-project moves reproject descendant relational ownership without
   * bumping their document revisions, and relationship endpoints have no FK row
   * all writers could lock. Taking the workspace row before any resolution is
   * therefore the common boundary: a create/update cannot retain a pre-move
   * parent projection, and a concurrent link/delete/move cannot create a stale
   * polymorphic edge. Every change set takes this as its first database lock,
   * avoiding lock-order inversions with the per-project key counters acquired
   * later.
   */
  async lockForChangeSet(scope: WorkspaceScope, tx: DbTransaction): Promise<void> {
    const [row] = await tx
      .select({ id: workspace.id })
      .from(workspace)
      .where(eq(workspace.id, scope))
      .for("update")
      .limit(1);
    if (!row) {
      throw new Error("the scoped workspace disappeared before the change set could run");
    }
  },

  /**
   * The projects the scope may see. This is the workspace aggregate's own
   * boundary — the per-entity repositories (B11) own everything below a
   * project — and it is what `api/handler/workspace.ts` and the web app's root
   * loader read to decide which project to open.
   */
  async listProjects(scope: WorkspaceScope): Promise<Project[]> {
    return await db
      .select()
      .from(project)
      .where(eq(project.workspaceId, scope))
      .orderBy(asc(project.name));
  },

  /**
   * Provisions the workspace's unversioned project container idempotently.
   *
   * Projects are not change-set entities: they have no document or revision,
   * and exist only to contain the versioned epic/stream/task tree. The unique
   * case-insensitive `(workspace_id, lower(name))` index is the concurrency
   * boundary. A losing insert waits for the winner and then reads that same
   * scoped row, so parallel browser/API or bootstrap calls return one id rather
   * than creating duplicates.
   */
  async ensureProject(scope: WorkspaceScope, name: string): Promise<EnsureProjectResult> {
    const normalizedName = projectNameSchema.parse(name);
    const [inserted] = await db
      .insert(project)
      .values({ workspaceId: scope, name: normalizedName })
      // No explicit target: both the retained exact index and the new lower(name)
      // expression index are legitimate conflicts. Naming either one would let
      // the other surface as a 500 under concurrency.
      .onConflictDoNothing()
      .returning();
    if (inserted) {
      return { status: "created", project: inserted };
    }

    const [existing] = await db
      .select()
      .from(project)
      .where(
        and(eq(project.workspaceId, scope), sql`lower(${project.name}) = lower(${normalizedName})`),
      )
      .limit(1);
    if (!existing) {
      throw new Error("project insert conflicted but the existing scoped row was not found");
    }
    return { status: "existing", project: existing };
  },

  /**
   * Deletes a project and everything it holds, or returns null when the id is
   * not a project in this scope.
   *
   * Entities, links and fragments cascade from `project_id`. Revisions have no
   * such foreign key (see `schema/entityRevision.ts`), so they are deleted here
   * once both their Project and their entity are gone. An entity moved out of
   * this project keeps the older revisions it wrote here, which its pinned
   * snapshots still read; they go with whichever later delete removes the
   * entity. The append-only trigger admits these deletes because
   * `spec.deleting_project_in_workspace` names the workspace for this
   * transaction only.
   *
   * The workspace lock is the same first lock every change set takes, so a
   * delete waits for an in-flight change set and a later one sees the project
   * gone rather than writing into a container that is being removed.
   */
  async deleteProject(scope: WorkspaceScope, projectId: string): Promise<Project | null> {
    return await db.transaction(async (tx) => {
      await workspaceRepository.lockForChangeSet(scope, tx);
      const [deleted] = await tx
        .delete(project)
        .where(and(eq(project.workspaceId, scope), eq(project.id, projectId)))
        .returning();
      if (!deleted) return null;

      // Canonical text, because the trigger compares it with `workspace_id::text`.
      await tx.execute(
        sql`select set_config('spec.deleting_project_in_workspace', ${scope}::uuid::text, true)`,
      );
      await tx
        .delete(entityRevision)
        .where(
          and(
            eq(entityRevision.workspaceId, scope),
            not(projectExists(tx, entityRevision.projectId)),
            not(entityExists(tx, entityRevision.entityId)),
          ),
        );
      await tx
        .delete(entityRevisionSummary)
        .where(
          and(
            eq(entityRevisionSummary.workspaceId, scope),
            not(projectExists(tx, entityRevisionSummary.projectId)),
            not(entityExists(tx, entityRevisionSummary.entityId)),
          ),
        );
      return deleted;
    });
  },

  /**
   * One project by id, inside the scope.
   *
   * The scope is part of the `WHERE`, not an assertion afterwards, so a project
   * id belonging to another tenant is indistinguishable from one that does not
   * exist — the caller gets `null` either way and cannot use the endpoint to
   * probe which ids are real elsewhere.
   */
  async findProject(scope: WorkspaceScope, projectId: string): Promise<Project | null> {
    const [row] = await db
      .select()
      .from(project)
      .where(and(eq(project.workspaceId, scope), eq(project.id, projectId)))
      .limit(1);
    return row ?? null;
  },

  /**
   * One project by the only two things an agent can know about it.
   *
   * A project row has no key and no slug — it has `id`, and a `name` that is
   * unique per workspace via `project_workspace_name_uniq`. So the name *is* the
   * human-facing identifier, and it is the one an agent has: it read it out of a
   * `get_context` result or the user said it. An id is accepted too, because the
   * web UI has one and a tool argument should not have to be translated first.
   *
   * The discriminator is the shape of the value, not a second argument: a uuid is
   * an id, anything else is a name. That cannot be ambiguous, because a project
   * whose *name* is a uuid would still be found by that uuid — the id lookup is
   * scoped, so it returns null and the name lookup is not reached only when the
   * uuid really is an id in this workspace.
   */
  async findProjectByRef(scope: WorkspaceScope, ref: string): Promise<Project | null> {
    if (UUID_PATTERN.test(ref)) {
      const byId = await workspaceRepository.findProject(scope, ref);
      if (byId) {
        return byId;
      }
    }
    const [row] = await db
      .select()
      .from(project)
      .where(and(eq(project.workspaceId, scope), sql`lower(${project.name}) = lower(${ref})`))
      .limit(1);
    return row ?? null;
  },
};

function projectExists(tx: DbTransaction, projectId: AnyPgColumn): SQL {
  return exists(tx.select({ id: project.id }).from(project).where(eq(project.id, projectId)));
}

/** True while a current Epic, Stream, Task, Milestone or Rule row has this id. */
function entityExists(tx: DbTransaction, entityId: AnyPgColumn): SQL {
  const checks = [epic, stream, task, milestone, rule].map((table) =>
    exists(tx.select({ id: table.id }).from(table).where(eq(table.id, entityId))),
  );
  return sql`(${sql.join(checks, sql` or `)})`;
}

/** Same shape `makeScope` checks. A non-uuid reaching a `uuid` column throws. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
