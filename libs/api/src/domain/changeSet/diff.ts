/** A compact, structured account of one semantic change. */
export type SemanticDiff =
  | {
      readonly kind: "entity";
      readonly change: "created" | "deleted";
      readonly entity: string;
      readonly key: string;
      readonly title: string | null;
    }
  | {
      readonly kind: "field";
      readonly path: string;
      readonly before: unknown;
      readonly after: unknown;
    }
  | {
      readonly kind: "id_collection";
      readonly path: string;
      readonly beforeCount: number;
      readonly afterCount: number;
      readonly added: readonly string[];
      readonly removed: readonly string[];
      readonly changed: readonly string[];
      readonly orderChanged: boolean;
    }
  | {
      readonly kind: "relationship";
      readonly change: "linked" | "unlinked";
      readonly relationship: string;
      readonly source: string;
      readonly target: string;
      readonly changed: boolean;
    }
  | {
      readonly kind: "cascade";
      readonly deleted: readonly { readonly entity: string; readonly key: string }[];
    }
  | {
      readonly kind: "impact";
      readonly affected: readonly string[];
    };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** JSON-semantic equality: object member order is not data, array order is. */
const jsonEqual = (left: unknown, right: unknown): boolean => {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => jsonEqual(value, right[index]))
    );
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && jsonEqual(left[key], right[key]))
  );
};

const idOf = (value: unknown): string | null => {
  if (!isRecord(value) || typeof value.id !== "string") {
    return null;
  }
  return value.id;
};

/**
 * Describes a canonical document transition without repeating whole documents.
 *
 * Arrays of id-bearing objects are the important case: a section replacement
 * reports which identities disappeared, appeared or changed, so an omitted
 * element cannot hide behind a generic "content changed" message.
 */
export function diffDocuments(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): readonly SemanticDiff[] {
  const changes: SemanticDiff[] = [];
  visit(before, after, "", changes);
  return changes;
}

function visit(before: unknown, after: unknown, path: string, changes: SemanticDiff[]): void {
  if (jsonEqual(before, after)) {
    return;
  }

  if (Array.isArray(before) && Array.isArray(after)) {
    const all = [...before, ...after];
    const ids = all.map(idOf);
    if (all.length > 0 && ids.every((id) => id !== null)) {
      const beforeById = new Map(before.map((value) => [idOf(value) as string, value]));
      const afterById = new Map(after.map((value) => [idOf(value) as string, value]));
      const beforeIds = [...beforeById.keys()];
      const afterIds = [...afterById.keys()];
      const added = afterIds.filter((id) => !beforeById.has(id));
      const removed = beforeIds.filter((id) => !afterById.has(id));
      const changed = beforeIds.filter(
        (id) => afterById.has(id) && !jsonEqual(beforeById.get(id), afterById.get(id)),
      );
      changes.push({
        kind: "id_collection",
        path,
        beforeCount: before.length,
        afterCount: after.length,
        added,
        removed,
        changed,
        orderChanged:
          added.length === 0 &&
          removed.length === 0 &&
          beforeIds.some((id, index) => afterIds[index] !== id),
      });
      // The collection summary makes omissions visible, while descending into
      // matching changed identities preserves the actual semantic edit. In
      // particular, a replaced Workflow must expose a removed STEP rather than
      // stopping at the opaque fact that WF-1 changed.
      for (const id of changed) {
        visit(beforeById.get(id), afterById.get(id), `${path}[${id}]`, changes);
      }
      return;
    }
  }

  if (isRecord(before) && isRecord(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    for (const key of keys) {
      visit(before[key], after[key], path.length === 0 ? key : `${path}.${key}`, changes);
    }
    return;
  }

  changes.push({ kind: "field", path, before, after });
}

export const entityDiff = (
  change: "created" | "deleted",
  entity: string,
  key: string,
  document: Record<string, unknown>,
): SemanticDiff => ({
  kind: "entity",
  change,
  entity,
  key,
  title: titleOf(document),
});

function titleOf(document: Record<string, unknown>): string | null {
  const meta = document.meta;
  return isRecord(meta) && typeof meta.title === "string" ? meta.title : null;
}
