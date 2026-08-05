/**
 * The tenant guarantee, expressed in the type system.
 *
 * `WorkspaceScope` is a branded `workspace.id`. The brand is a `unique symbol`
 * that is only ever `declare`d — it exists at type level and nowhere at
 * runtime, so the value really is just the uuid string and can be handed
 * straight to `eq(table.workspaceId, scope)`.
 *
 * The point of the brand is that a bare `string` is *not* assignable to it.
 * Every tenant-scoped repository method takes `scope: WorkspaceScope` first,
 * so the only way to query through one is to have produced a scope, and the
 * only way to produce one is `makeScope`. Forgetting the tenant filter therefore
 * stops being a silent cross-tenant read and becomes a compile error.
 *
 * `makeScope` has exactly three legitimate production callers:
 *  1. `domain/auth/resolveMcpAuth.ts`  — the `org_id` claim of an OAuth token,
 *  2. `domain/auth/resolveSessionAuth.ts` — the Clerk session of the web app,
 *  3. `scripts/bootstrapProject.ts` — an operator-supplied `org_id` resolved
 *     read-only to an existing local workspace row.
 * Test fixtures and focused unit tests also construct known uuid scopes. The
 * auth resolvers get the uuid from
 * `workspaceRepository.ensure`; the bootstrap command gets it from
 * `workspaceRepository.findByClerkOrgId`. None accepts a local uuid from user
 * input. Any further caller in `src/` is a review question.
 */
declare const workspaceScopeBrand: unique symbol;

export type WorkspaceScope = string & { readonly [workspaceScopeBrand]: "WorkspaceScope" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Wraps a `workspace.id`.
 *
 * The uuid check is not decoration: the two things in scope at the call site
 * are the local `workspace.id` and the Clerk `org_id` (`org_2ab…`), they are
 * both strings, and passing the wrong one would produce a query that silently
 * matches nothing rather than an error. Failing here instead turns that
 * mix-up into an immediate, locatable throw.
 */
export function makeScope(workspaceId: string): WorkspaceScope {
  if (!UUID.test(workspaceId)) {
    throw new Error(
      `makeScope expects a workspace.id uuid, got ${JSON.stringify(workspaceId)} — a Clerk org_id must be resolved through the workspace repository first`,
    );
  }
  return workspaceId as WorkspaceScope;
}
