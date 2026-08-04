import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * One row per Clerk Organization, 1:1. The row is created just-in-time on the
 * first authenticated request that carries an `org_id` claim
 * (`repository/workspace.ts#ensure`) — there is deliberately no Clerk webhook,
 * no membership table and no backfill job, so `clerk_org_id` is the only thing
 * that has to stay in sync with Clerk and it is carried by the token itself.
 *
 * `id` is a local uuid rather than the Clerk id: it is what every child row
 * denormalises as `workspace_id` and what `WorkspaceScope` wraps, so the
 * tenant key stays a uuid the whole way down and never leaks the auth
 * provider's identifier format into the data model.
 */
export const workspace = pgTable("workspace", {
  id: uuid().defaultRandom().primaryKey(),
  clerkOrgId: text().notNull().unique(),
  name: text().notNull(),
  /** Clerk organizations may have no slug, so this is nullable by design. */
  slug: text(),
  createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
});
