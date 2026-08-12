import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgTable, primaryKey, text, uuid } from "drizzle-orm/pg-core";
import type { VersionedEntityType } from "../../../domain/enums";
import type { SpecFragmentModel } from "../../../domain/service/specFragment";
import { project } from "./project";
import { workspace } from "./workspace";

export type FragmentBacklink = { readonly id: string; readonly key: string };

/**
 * Current specification fragments, expanded from the authoritative entity document.
 *
 * Documents remain the write model and revision snapshots remain the history. This
 * table is deliberately disposable: a deployment backfill can rebuild every row,
 * while normal writes replace one owner's rows in the same transaction as its
 * document and revision. Keeping the renderer model as JSON means the reader does
 * not have to reinterpret a whole project merely to return one page.
 */
export const projectFragment = pgTable(
  "project_fragment",
  {
    workspaceId: uuid()
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    projectId: uuid()
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    ownerType: text().$type<VersionedEntityType>().notNull(),
    /** Polymorphic current-entity identity; intentionally has no concrete FK. */
    ownerId: uuid().notNull(),
    ownerKey: text().notNull(),
    ownerTitle: text().notNull(),
    ownerKindOrder: integer().notNull(),
    ownerSequence: integer().notNull(),
    section: text().notNull(),
    anchor: text().notNull(),
    /** Reading order inside one owner after `SECTION_ORDER` has been applied. */
    position: integer().notNull(),
    fragment: jsonb().$type<SpecFragmentModel>().notNull(),
    fragmentText: text().notNull(),
    fuzzyChars: text()
      .array()
      .generatedAlwaysAs(sql`string_to_array(lower(fragment_text), null)`),
    /** Anchor plus rendered text, used by substring and fuzzy candidate lookup. */
    searchText: text().notNull(),
    /** Current Tasks whose `implements` object names this Stream fragment. */
    backlinks: jsonb().$type<readonly FragmentBacklink[]>().notNull(),
  },
  (t) => [
    primaryKey({
      columns: [t.workspaceId, t.projectId, t.ownerType, t.ownerId, t.anchor],
    }),
    index("project_fragment_page_idx").on(
      t.workspaceId,
      t.projectId,
      t.ownerKindOrder,
      t.ownerSequence,
      t.position,
    ),
    index("project_fragment_owner_idx").on(t.workspaceId, t.ownerType, t.ownerId),
    index("project_fragment_key_idx").on(t.workspaceId, t.projectId, t.ownerKey, t.position),
    index("project_fragment_section_idx").on(
      t.workspaceId,
      t.projectId,
      t.section,
      t.ownerKindOrder,
      t.ownerSequence,
      t.position,
    ),
    index("project_fragment_search_idx").using("gin", t.searchText.asc().op("gin_trgm_ops")),
    index("project_fragment_fuzzy_idx").using("gin", t.fuzzyChars),
    index("project_fragment_backlink_idx").using("gin", t.backlinks),
  ],
);
