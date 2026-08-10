import { type DocumentIssue, ruleIssue, shapeIssue } from "../schema/rules";
import type { ChangeSetItemMutation } from "./schema";

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
 * `id`, `key` and `revision` from the row it is writing
 * (`repository/entity.ts`'s `stampServerOwnedMeta`), unconditionally and last.
 * Project and workspace ownership live only on relational rows. One authority at
 * the point where each true value exists beats a filter here that would have to
 * be kept in step with the envelope.
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

/**
 * Id-bearing collections that can be edited element-by-element.
 *
 * This is deliberately an allow-list rather than a generic JSON pointer. A path
 * here promises three things the item protocol relies on: the value is an array,
 * every element is a complete object with an `id`, and that id is the stable
 * selector for the collection. Nested workflow steps are intentionally absent;
 * replace the owning workflow until steps have an independent lifecycle need.
 */
export const ITEM_COLLECTION_PATHS = [
  "content.scope.included",
  "content.scope.excluded",
  "content.discovery_scope.included",
  "content.discovery_scope.excluded",
  "content.outcomes",
  "content.success_metrics",
  "content.rule_applications",
  "content.workflows",
  "content.edge_cases",
  "content.requirements.functional",
  "content.requirements.non_functional",
  "content.acceptance_criteria",
  "content.behavior_cases",
  "content.changes",
  "content.hypotheses",
  "content.research_questions",
  "content.success_criteria",
  "content.decision_rules",
  "content.questions",
  "content.refactor_targets",
  "content.invariants",
  "content.quality_goals",
  "content.maintenance_goals",
  "content.risks",
  "content.assumptions",
  "content.open_questions",
  "content.exit_criteria",
  "content.verification",
  "provenance.sources",
] as const;

const itemCollectionPaths = new Set<string>(ITEM_COLLECTION_PATHS);

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

/**
 * Applies complete-element mutations in order and returns one new owner document.
 *
 * `update.items` is bundled under one expected revision specifically so several
 * edits do not force the caller to predict intermediate revision numbers. The
 * function remains pure for the same reason as `applySectionPatch`: validation
 * and apply can derive the same before/after state without mutating either input.
 */
export function applyItemMutations(
  document: Record<string, unknown>,
  mutations: readonly ChangeSetItemMutation[],
): PatchResult {
  const issues: DocumentIssue[] = [];
  let next = document;

  mutations.forEach((mutation, index) => {
    const issuePath = `items[${String(index)}]`;
    if (!itemCollectionPaths.has(mutation.path)) {
      issues.push(
        shapeIssue(
          `${issuePath}.path`,
          `${mutation.path} is not an addressable id collection. Allowed paths: ${ITEM_COLLECTION_PATHS.join(", ")}.`,
        ),
      );
      return;
    }

    const segments = mutation.path.split(".");
    const located = valueAt(next, segments);
    if (!located.ok) {
      issues.push(shapeIssue(`${issuePath}.path`, located.message));
      return;
    }
    const current = located.value === undefined ? [] : located.value;
    if (!Array.isArray(current)) {
      issues.push(shapeIssue(`${issuePath}.path`, `${mutation.path} is not an array.`));
      return;
    }

    const matching = current.flatMap((element, position) =>
      isPlainObject(element) && element.id === mutation.id ? [position] : [],
    );
    if (matching.length > 1) {
      issues.push(
        shapeIssue(
          `${issuePath}.id`,
          `${mutation.path} contains ${String(matching.length)} elements with id ${mutation.id}; identity must be unique before it can be addressed.`,
        ),
      );
      return;
    }

    if (mutation.action === "add") {
      if (matching.length > 0) {
        issues.push(
          shapeIssue(
            `${issuePath}.id`,
            `${mutation.path} already contains ${mutation.id}; add never behaves as upsert.`,
          ),
        );
        return;
      }
      if (!isPlainObject(mutation.value) || mutation.value.id !== mutation.id) {
        issues.push(
          shapeIssue(
            `${issuePath}.value`,
            `add needs a complete object whose id is ${mutation.id}.`,
          ),
        );
        return;
      }
      next = setAt(next, segments, [...current, mutation.value]);
      return;
    }

    const [position] = matching;
    if (position === undefined) {
      issues.push(
        shapeIssue(
          `${issuePath}.id`,
          `${mutation.path} has no element ${mutation.id}; ${mutation.action} never behaves as upsert.`,
        ),
      );
      return;
    }

    if (mutation.action === "remove") {
      next = setAt(
        next,
        segments,
        current.filter((_, candidate) => candidate !== position),
      );
      return;
    }

    if (!isPlainObject(mutation.value) || mutation.value.id !== mutation.id) {
      issues.push(
        shapeIssue(
          `${issuePath}.value`,
          `replace needs a complete object whose id remains ${mutation.id}.`,
        ),
      );
      return;
    }
    const replacement = [...current];
    replacement[position] = mutation.value;
    next = setAt(next, segments, replacement);
  });

  return issues.length > 0 ? { ok: false, issues } : { ok: true, document: next };
}

type LocatedValue =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly message: string };

function valueAt(root: Record<string, unknown>, segments: readonly string[]): LocatedValue {
  let current: unknown = root;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (!isPlainObject(current) || segment === undefined) {
      return {
        ok: false,
        message: `${segments.slice(0, index).join(".") || "document"} is not an object, so ${segments.join(".")} cannot be addressed.`,
      };
    }
    current = current[segment];
    if (current === undefined && index < segments.length - 1) {
      return {
        ok: false,
        message: `${segments.slice(0, index + 1).join(".")} does not exist; create its owning section before editing a nested item.`,
      };
    }
  }
  return { ok: true, value: current };
}

function setAt(
  root: Record<string, unknown>,
  segments: readonly string[],
  value: unknown,
): Record<string, unknown> {
  const [head, ...tail] = segments;
  if (head === undefined) {
    return root;
  }
  if (tail.length === 0) {
    return { ...root, [head]: value };
  }
  const child = root[head];
  if (!isPlainObject(child)) {
    return root;
  }
  return { ...root, [head]: setAt(child, tail, value) };
}
