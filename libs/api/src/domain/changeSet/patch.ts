import { type DocumentIssue, ruleIssue, shapeIssue } from "../schema/rules";

/**
 * How an `update` operation's `data` is merged into a stored document: **one
 * section at a time, replaced whole**.
 *
 * ## Why replace and not deep-merge
 *
 * A deep merge has no defined answer for arrays, and every document section that
 * matters is an array: `acceptance_criteria`, `requirements.functional`,
 * `workflows`. Concatenating duplicates a criterion an agent re-sent; merging by
 * index silently rewrites the wrong element when the order changed; merging by a
 * guessed identity key needs a key that not every element has. Replacement has
 * one answer and it is the one an author expects: *what I sent is what the section
 * now says*. The cost is stated where a tool author reads it — the `data`
 * description in `changeSet/schema.ts` says arrays are not merged, so send the
 * complete list.
 *
 * ## Why the granularity is the *section* and not the document
 *
 * Replacing the whole document would make every edit a full rewrite, and an agent
 * that re-sent an out-of-date `content` would silently drop the section someone
 * else added under a revision it never read. Replacing individual leaves would
 * put us back in deep-merge territory. Sections — the second level, one below
 * `meta` / `content` / `links` / `provenance` / `execution` — are the unit the
 * domain spec §5 document is actually built from, and the unit `get_entity_schema`
 * describes.
 *
 * It is also the granularity that keeps a `meta` edit safe: `data.meta.status`
 * replaces the status and leaves `meta.id`, `meta.key` and `meta.revision`
 * standing. A whole-`meta` replacement would drop them.
 *
 * ## Server-owned fields are not filtered here
 *
 * A patch that sets `meta.revision: 99` is not rejected by this function, because
 * this function is not where that is decided: every repository write re-stamps
 * `id`, `key`, `project_id`, `workspace_id` and `revision` from the row it is
 * writing (`repository/entity.ts`'s `stampServerOwnedMeta`), unconditionally and
 * last. One authority for those five fields, at the point where the true values
 * exist, beats a filter here that would have to be kept in step with the envelope.
 *
 * Pure: no database, no service logic, no I/O. `repository/entity.ts` uses it for
 * the document edit inside `archive` and `move`, so the flip of `meta.status` and
 * the rewrite of `links.parent_epic_id` go through the same merge an agent's
 * `update` does.
 */

/**
 * The document's top-level groups, and the only keys a patch may name.
 *
 * `entity` and `schema_version` are absent on purpose: both are `z.literal`s in
 * the envelope, so a patch that changed them would either be a no-op or turn the
 * document into one that no longer parses as its own type. `execution` is a task
 * -only group (domain spec §7); listing it for every entity costs nothing, since
 * a patch naming it on an epic produces a document `parseDocument` rejects.
 */
export const PATCHABLE_GROUPS = ["meta", "content", "links", "provenance", "execution"] as const;

export type PatchResult =
  | { readonly ok: true; readonly document: Record<string, unknown> }
  | { readonly ok: false; readonly issues: readonly DocumentIssue[] };

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Merges `patch` into `document`, replacing each named section whole.
 *
 * Returns a new document; neither argument is mutated, so a caller can report the
 * before and after state of a conflict without having lost the before.
 *
 * An empty stored document is a valid input — that is the `create` path, where the
 * patch *is* the document. The envelope's `entity` and `schema_version` literals
 * are the caller's to add: they follow from which entity is being created, which
 * is a decision one level up.
 */
export function applySectionPatch(
  document: Record<string, unknown>,
  patch: Record<string, unknown>,
): PatchResult {
  const issues: DocumentIssue[] = [];
  const next: Record<string, unknown> = { ...document };

  for (const [group, sections] of Object.entries(patch)) {
    if (!(PATCHABLE_GROUPS as readonly string[]).includes(group)) {
      issues.push(ruleIssue("no_invented_fields", group));
      continue;
    }
    if (!isPlainObject(sections)) {
      issues.push(
        shapeIssue(
          group,
          `${group} must be an object of sections; send the sections you are changing, not a replacement for the whole group.`,
        ),
      );
      continue;
    }
    const current = next[group];
    if (current !== undefined && !isPlainObject(current)) {
      // The stored document is not shaped like a document. Refusing beats
      // overwriting: whatever is there was written by something, and this
      // function is not the place to decide it was junk.
      issues.push(shapeIssue(group, `the stored document's ${group} is not an object.`));
      continue;
    }
    next[group] = { ...current, ...sections };
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }
  return { ok: true, document: next };
}
