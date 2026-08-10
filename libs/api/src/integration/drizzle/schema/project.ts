import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { workspace } from "./workspace";

// PostgreSQL's one-argument btrim removes only U+0020. This is the complete
// whitespace set ECMAScript String.prototype.trim (and therefore Zod .trim())
// removes, expressed as a PostgreSQL Unicode-escape string so the database
// invariant cannot drift on tabs, line breaks or Unicode boundary whitespace.
const ECMASCRIPT_TRIM_CHARACTERS = sql.raw(
  "U&'\\0009\\000A\\000B\\000C\\000D\\0020\\00A0\\1680\\2000\\2001\\2002\\2003\\2004\\2005\\2006\\2007\\2008\\2009\\200A\\2028\\2029\\202F\\205F\\3000\\FEFF'",
);

/**
 * A project is a technical container inside a workspace (domain spec §3), not a
 * planning object: it has no `document`, no `revision` and no status, because
 * none of its planning content is versioned. Its name is still validated as the
 * container's human-facing identity. The five counter columns are the reason
 * it is a table of its own rather than a column on `workspace`.
 *
 * The entity counters are the key sequences behind `E-1`, `S-12`, `T-45`,
 * `M-2` and `R-7`. They live on this row, not in a Postgres sequence, so the
 * change-set transaction can take `SELECT … FOR UPDATE` on the project row and
 * hand out keys race-free without retry logic — and so a rolled-back change-set
 * does not burn a key the way a sequence would. Each column holds the last key
 * issued; `domain/repository/entity.ts` owns the increment.
 */
export const project = pgTable(
  "project",
  {
    id: uuid().defaultRandom().primaryKey(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    name: text().notNull(),
    epicCounter: integer().notNull().default(0),
    streamCounter: integer().notNull().default(0),
    taskCounter: integer().notNull().default(0),
    milestoneCounter: integer().notNull().default(0),
    ruleCounter: integer().notNull().default(0),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // The name is how an agent addresses a project in natural language
    // ("add an epic to zpecs"), so it has to resolve to exactly one row.
    uniqueIndex("project_workspace_name_uniq").on(t.workspaceId, t.name),
    // Keep the exact index above during rollout. This expression index is the
    // stronger invariant used by self-service creation: spelling case cannot
    // create two human-indistinguishable containers in one workspace.
    uniqueIndex("project_workspace_name_lower_uniq").on(t.workspaceId, sql`lower(${t.name})`),
    index("project_workspace_idx").on(t.workspaceId),
    // Application inputs are normalized too, but the database remains the last
    // line of defence for scripts, migrations and any future writer.
    check(
      "project_name_normalized_chk",
      sql`${t.name} = btrim(${t.name}, ${ECMASCRIPT_TRIM_CHARACTERS}) and char_length(${t.name}) between 1 and 120`,
    ),
  ],
);
