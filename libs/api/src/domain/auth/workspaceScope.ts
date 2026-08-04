/**
 * The tenant guarantee, expressed in the type system.
 *
 * `WorkspaceScope` is a branded `workspace.id`. The brand is a `unique symbol`
 * that is only ever `declare`d — it exists at type level and nowhere at
 * runtime, so the value really is just the uuid string and can be handed
 * straight to `eq(table.workspaceId, scope)`.
 *
 * The point of the brand is that a bare `string` is *not* assignable to it.
 * Every repository method takes `scope: WorkspaceScope` first, so the only way
 * to query a tenant-scoped table is to have produced a scope, and the only way
 * to produce one is `makeScope`. Forgetting the tenant filter therefore stops
 * being a silent cross-tenant read and becomes a compile error.
 *
 * `makeScope` has exactly two legitimate callers in `src/`:
 *  1. `domain/auth/resolveMcpAuth.ts`  — the `org_id` claim of an OAuth token,
 *  2. `domain/auth/resolveSessionAuth.ts` — the Clerk session of the web app,
 * plus the test fixtures (`test/fixtures/db/harness.ts` for DB tests,
 * `test/fixtures/auth.ts` for the offline suites), which are the only callers
 * outside `src/`. Both resolvers get the uuid from `workspaceRepository.ensure`,
 * never from user input. If a third caller in `src/` ever appears, that is the
 * review question.
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
      `makeScope expects a workspace.id uuid, got ${JSON.stringify(workspaceId)} — a Clerk org_id must be resolved through workspaceRepository.ensure first`,
    );
  }
  return workspaceId as WorkspaceScope;
}
