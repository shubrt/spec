import { eq } from "drizzle-orm";
import { db } from "../../integration/drizzle/client";
import { workspace } from "../../integration/drizzle/schema/workspace";
import type { WorkspaceScope } from "../auth/workspaceScope";

export type Workspace = typeof workspace.$inferSelect;

export type EnsureWorkspaceInput = {
  clerkOrgId: string;
  name: string;
  slug: string | null;
};

export const workspaceRepository = {
  /**
   * The one repository function that deliberately takes no `scope` first: it is
   * what *creates* the scope. Everything else in this layer receives a
   * `WorkspaceScope` because a tenant already exists; `ensure` runs before one
   * does, from the `org_id` claim of a verified token, which is why it is safe
   * for it to be unscoped and why nothing else may be.
   *
   * `test/domain/repository/scope.test.ts` names this function in its
   * `UNSCOPED` allow-list, so the exception is recorded once and is checked to
   * still exist rather than being tolerated implicitly.
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

  /** The scope's own row. Returns null only if the workspace was deleted mid-session. */
  async find(scope: WorkspaceScope): Promise<Workspace | null> {
    const [row] = await db.select().from(workspace).where(eq(workspace.id, scope)).limit(1);
    return row ?? null;
  },
};
