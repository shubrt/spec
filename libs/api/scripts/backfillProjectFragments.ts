/// <reference types="node" />
/// <reference types="bun-types" />
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { env } from "../src/_/env";
import { makeScope } from "../src/domain/auth/workspaceScope";
import {
  replaceOwnerFragments,
  replaceTaskBacklinks,
} from "../src/domain/repository/projectFragment";
import { epic } from "../src/integration/drizzle/schema/epic";
import { milestone } from "../src/integration/drizzle/schema/milestone";
import { projectFragment } from "../src/integration/drizzle/schema/projectFragment";
import { rule } from "../src/integration/drizzle/schema/rule";
import { stream } from "../src/integration/drizzle/schema/stream";
import { task } from "../src/integration/drizzle/schema/task";
import { schema } from "../src/integration/drizzle/schema";

/**
 * Idempotently rebuilds the disposable fragment projection from current documents.
 *
 * SHARE locks make the delete-and-fill one atomic cutover: existing writers finish
 * first, new writers wait, and after commit every waiting writer applies its own
 * normal incremental projection update. Readers see either the prior committed
 * projection or the complete rebuilt one, never the empty middle.
 */
async function backfill(): Promise<number> {
  const pool = new Pool({ connectionString: env.DATABASE_URL });
  const database = drizzle(pool, { schema, casing: "snake_case" });
  try {
    return await database.transaction(async (tx) => {
      await tx.execute(sql`lock table epic, stream, task, milestone, rule in share mode`);
      await tx.execute(sql`lock table project_fragment in exclusive mode`);
      // One transaction owns one PostgreSQL connection, so issue these reads in
      // sequence rather than queueing concurrent client.query calls on it.
      const epics = await tx.select().from(epic);
      const streams = await tx.select().from(stream);
      const tasks = await tx.select().from(task);
      const milestones = await tx.select().from(milestone);
      const rules = await tx.select().from(rule);
      await tx.delete(projectFragment);

      for (const [entityType, rows] of [
        ["epic", epics],
        ["stream", streams],
        ["task", tasks],
        ["milestone", milestones],
        ["rule", rules],
      ] as const) {
        for (const row of rows) {
          await replaceOwnerFragments(makeScope(row.workspaceId), tx, {
            entityType,
            entityId: row.id,
            projectId: row.projectId,
            document: row.document,
          });
        }
      }
      // Stream projection already derives these backlinks, but replaying Tasks
      // makes the invariant explicit and keeps the backfill correct if a future
      // owner rebuild stops joining Tasks.
      for (const row of tasks) {
        await replaceTaskBacklinks(makeScope(row.workspaceId), tx, {
          taskId: row.id,
          taskKey: row.key,
          projectId: row.projectId,
          document: row.document,
        });
      }
      return epics.length + streams.length + tasks.length + milestones.length + rules.length;
    });
  } finally {
    await pool.end();
  }
}

if (import.meta.main) {
  const owners = await backfill();
  process.stdout.write(`Rebuilt project_fragment from ${String(owners)} current entities.\n`);
}
