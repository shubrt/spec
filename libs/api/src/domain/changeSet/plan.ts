import type { EntityType } from "../enums";
import { parseKey } from "../keys";
import { type DocumentIssue, ruleIssue, shapeIssue } from "../schema/rules";
import {
  type ChangeSet,
  type ChangeSetOperation,
  type LinkInputRelationship,
  OPERATION_FIELDS,
  isTempId,
} from "./schema";

/**
 * Turns a parsed change set into an ordered, self-consistent plan — or into the
 * list of reasons it is neither.
 *
 * This is where everything the flat operation schema cannot express structurally
 * is checked. `changeSet/schema.ts` explains why that split exists:
 * `z.toJSONSchema()` silently drops `.refine()`, so a cross-field rule expressed
 * in Zod would be invisible to the model that has to satisfy it. Here the same
 * rules produce a `DocumentIssue` with a path — which is what `validate_change_set`
 * returns and therefore the only feedback channel that actually reaches an agent.
 *
 * Pure: no database, no repository, no I/O. Every check is answerable from the
 * change set itself. "Does `STR-12` exist?" and "would this close a dependency
 * cycle?" are not, so they are the pipeline's (B14) and belong nowhere near this
 * file.
 *
 * ## Ordering
 *
 * Operations are applied in the order the author wrote them, with exactly one
 * exception: an operation that references a temp id is moved after the `create`
 * that defines it. The reordering is minimal — the plan repeatedly takes the
 * earliest operation whose references are all defined — so an agent's sequence is
 * preserved wherever it is already valid, and a set that needed no reordering
 * comes out identical. Operations that reference each other in a circle can never
 * become eligible, and that is reported rather than silently truncated.
 */

/**
 * A resolved reference to the thing an operation acts on or points at.
 *
 * A `key` ref carries the entity type it decoded to, so the pipeline does not
 * re-parse the key to decide which repository to call. A `temp` ref names an
 * entity this change set creates earlier in the plan — the ordering guarantees the
 * `create` has already run, so the pipeline only has to remember the id it got.
 * A `project` ref is a project *name*: a project has no key, because it is a
 * container rather than a versioned entity, and the name is how an agent addresses
 * it in natural language.
 */
export type PlanRef =
  | { readonly kind: "key"; readonly key: string; readonly entity: EntityType }
  | { readonly kind: "temp"; readonly ref: string }
  | { readonly kind: "project"; readonly name: string };

export type PlannedOperation = {
  /** Position in the submitted change set, so an issue or an error can name it. */
  readonly index: number;
} & (
  | {
      readonly kind: "create";
      readonly entity: EntityType;
      /** The temp id later operations reference, if the author declared one. */
      readonly ref: string | null;
      readonly parent: PlanRef;
      readonly data: Record<string, unknown>;
    }
  | {
      readonly kind: "update";
      readonly target: KeyRef;
      readonly expectedRevision: number;
      readonly data: Record<string, unknown>;
    }
  | {
      readonly kind: "archive" | "delete";
      readonly target: KeyRef;
      readonly expectedRevision: number;
    }
  | {
      readonly kind: "move";
      readonly target: KeyRef;
      readonly expectedRevision: number;
      readonly parent: PlanRef;
    }
  | {
      readonly kind: "link" | "unlink";
      readonly source: PlanRef;
      readonly target: PlanRef;
      readonly relationship: LinkInputRelationship;
    }
);

/** An operation that acts on an entity that already exists can only name a key. */
type KeyRef = Extract<PlanRef, { kind: "key" }>;

export type PlanResult =
  | { readonly ok: true; readonly plan: readonly PlannedOperation[] }
  | { readonly ok: false; readonly issues: readonly DocumentIssue[] };

/** Which parent an entity hangs from. An epic hangs from the project. */
const PARENT_ENTITY = {
  epic: null,
  stream: "epic",
  task: "stream",
} as const satisfies Record<EntityType, EntityType | null>;

export function planChangeSet(changeSet: ChangeSet): PlanResult {
  const issues: DocumentIssue[] = [];
  /** Temp id → the entity type the `create` that defines it will produce. */
  const declared = new Map<string, EntityType>();

  // Two passes: a temp id may be referenced by an operation that comes *before*
  // the create declaring it, so every declaration has to be known before any
  // reference is judged.
  changeSet.operations.forEach((operation, index) => {
    if (operation.operation !== "create" || operation.key === undefined) {
      return;
    }
    const path = `operations[${index}].key`;
    if (!isTempId(operation.key)) {
      issues.push(
        parseKey(operation.key) === null
          ? shapeIssue(
              path,
              `${operation.key} is not a usable temp id. A create's key is an optional temp id: $ followed by lower-case letters, digits and underscores, e.g. $new_stream.`,
            )
          : // The author named a real key on a create. Keys come from the
            // project's counter, so the rule that says so is the right feedback.
            ruleIssue("server_owned_meta_is_not_writable", path),
      );
      return;
    }
    if (declared.has(operation.key)) {
      issues.push(
        shapeIssue(
          path,
          `${operation.key} is declared by more than one create in this change set.`,
        ),
      );
      return;
    }
    if (operation.entity !== undefined) {
      declared.set(operation.key, operation.entity);
    }
  });

  const planned: PlannedOperation[] = [];
  changeSet.operations.forEach((operation, index) => {
    const context: OperationContext = { index, operation, declared, issues };
    reportUnusedFields(context);
    const built = buildOperation(context);
    if (built) {
      planned.push(built);
    }
  });

  if (issues.length > 0) {
    return { ok: false, issues };
  }
  return orderPlan(planned);
}

type OperationContext = {
  readonly index: number;
  readonly operation: ChangeSetOperation;
  readonly declared: Map<string, EntityType>;
  readonly issues: DocumentIssue[];
};

/**
 * A field an operation does not use is a misunderstanding, not noise: `data` on a
 * `delete` most likely means the author meant `update`, and silently ignoring it
 * would apply a delete they did not intend. The schema cannot express this — the
 * operation is one flat object so that the generated JSON Schema stays small — so
 * `OPERATION_FIELDS` is the single list and this is the check that reads it.
 */
function reportUnusedFields({ index, operation, issues }: OperationContext): void {
  const allowed: readonly string[] = OPERATION_FIELDS[operation.operation];
  for (const [field, value] of Object.entries(operation)) {
    if (field === "operation" || value === undefined || allowed.includes(field)) {
      continue;
    }
    issues.push(
      shapeIssue(
        `operations[${index}].${field}`,
        `${field} is not used by ${operation.operation}. It is used by ${Object.entries(
          OPERATION_FIELDS,
        )
          .filter(([, fields]) => (fields as readonly string[]).includes(field))
          .map(([kind]) => kind)
          .join(", ")}.`,
      ),
    );
  }
}

function buildOperation(context: OperationContext): PlannedOperation | null {
  const { index, operation } = context;
  switch (operation.operation) {
    case "create": {
      const entity = operation.entity;
      if (entity === undefined) {
        context.issues.push(
          shapeIssue(`operations[${index}].entity`, "create needs the entity it creates."),
        );
        return null;
      }
      const data = requireData(context);
      const parent = parentRef(context, entity);
      if (!data || !parent) {
        return null;
      }
      return {
        index,
        kind: "create",
        entity,
        ref: operation.key ?? null,
        parent,
        data,
      };
    }
    case "update": {
      const target = keyRef(context);
      const expectedRevision = requireExpectedRevision(context);
      const data = requireData(context);
      if (!target || expectedRevision === null || !data) {
        return null;
      }
      return { index, kind: "update", target, expectedRevision, data };
    }
    case "archive":
    case "delete": {
      const target = keyRef(context);
      const expectedRevision = requireExpectedRevision(context);
      if (!target || expectedRevision === null) {
        return null;
      }
      return { index, kind: operation.operation, target, expectedRevision };
    }
    case "move": {
      const target = keyRef(context);
      const expectedRevision = requireExpectedRevision(context);
      if (!target || expectedRevision === null) {
        return null;
      }
      const parent = parentRef(context, target.entity);
      if (!parent) {
        return null;
      }
      return { index, kind: "move", target, expectedRevision, parent };
    }
    case "link":
    case "unlink": {
      const { relationship } = operation;
      if (relationship === undefined) {
        context.issues.push(
          shapeIssue(
            `operations[${index}].relationship`,
            `${operation.operation} needs the relationship it establishes.`,
          ),
        );
      }
      const source = endpointRef(context, "source");
      const target = endpointRef(context, "target");
      if (!source || !target || relationship === undefined) {
        return null;
      }
      return { index, kind: operation.operation, source, target, relationship };
    }
  }
}

function requireData({
  index,
  operation,
  issues,
}: OperationContext): Record<string, unknown> | null {
  if (operation.data === undefined || Object.keys(operation.data).length === 0) {
    issues.push(
      shapeIssue(
        `operations[${index}].data`,
        `${operation.operation} needs data: the document sections to write. Call get_entity_schema for the shape.`,
      ),
    );
    return null;
  }
  return operation.data;
}

function requireExpectedRevision({ index, operation, issues }: OperationContext): number | null {
  if (operation.expected_revision === undefined) {
    issues.push(
      shapeIssue(
        `operations[${index}].expected_revision`,
        `${operation.operation} needs expected_revision — the revision get_context returned for this entity. It is what makes the write safe against a concurrent change.`,
      ),
    );
    return null;
  }
  return operation.expected_revision;
}

/** The entity an operation acts on. Always an existing one, so always a key. */
function keyRef({ index, operation, issues }: OperationContext): KeyRef | null {
  const path = `operations[${index}].key`;
  if (operation.key === undefined) {
    issues.push(
      shapeIssue(path, `${operation.operation} needs key: the key of the entity it acts on.`),
    );
    return null;
  }
  if (operation.key.startsWith("$")) {
    // A temp id names something this change set is creating, and creating a thing
    // only to update, archive, delete or move it in the same set means the create
    // itself was wrong. The sigil is what makes this distinguishable from a
    // mistyped key at all.
    issues.push(
      shapeIssue(
        path,
        `${operation.key} is a temp id, so it names an entity this change set creates. ${operation.operation} needs the key of an entity that already exists.`,
      ),
    );
    return null;
  }
  const parsed = parseKey(operation.key);
  if (!parsed) {
    issues.push(
      shapeIssue(
        path,
        `${operation.key} is not an entity key. Keys look like EPIC-1, STR-12, TASK-45.`,
      ),
    );
    return null;
  }
  return { kind: "key", key: operation.key, entity: parsed.entity };
}

/**
 * The parent a `create` hangs the new entity from, or a `move` re-hangs it under.
 *
 * The pairing is checked here because it is answerable here: a key decodes to its
 * entity type, and a temp id resolves to the type of the `create` that declares
 * it. Catching "a task under an epic" now yields a sentence an agent can act on,
 * instead of a foreign-key violation from the database after half the change set
 * has been built.
 */
function parentRef(context: OperationContext, entity: EntityType): PlanRef | null {
  const { index, operation, issues } = context;
  const path = `operations[${index}].parent`;
  const expected = PARENT_ENTITY[entity];

  if (operation.parent === undefined) {
    issues.push(
      shapeIssue(
        path,
        expected === null
          ? `${operation.operation} of an epic needs parent: the name of the project it belongs to.`
          : `${operation.operation} of a ${entity} needs parent: the ${expected} it belongs to, by key or temp id.`,
      ),
    );
    return null;
  }

  if (expected === null) {
    if (isTempId(operation.parent)) {
      issues.push(
        shapeIssue(
          path,
          "An epic's parent is a project, named by its project name. A change set cannot create a project.",
        ),
      );
      return null;
    }
    return { kind: "project", name: operation.parent };
  }

  const actual = referencedEntity(context, operation.parent, path);
  if (actual === null) {
    return null;
  }
  if (actual !== expected) {
    issues.push(
      shapeIssue(
        path,
        `A ${entity} hangs from ${expected === "epic" ? "an" : "a"} ${expected}, and ${operation.parent} is a ${actual}.`,
      ),
    );
    return null;
  }
  return isTempId(operation.parent)
    ? { kind: "temp", ref: operation.parent }
    : { kind: "key", key: operation.parent, entity: actual };
}

/** A link endpoint: any entity, existing or created by this change set. */
function endpointRef(context: OperationContext, field: "source" | "target"): PlanRef | null {
  const { index, operation, issues } = context;
  const path = `operations[${index}].${field}`;
  const value = operation[field];
  if (value === undefined) {
    issues.push(
      shapeIssue(path, `${operation.operation} needs ${field}: a key or a temp id from this set.`),
    );
    return null;
  }
  const entity = referencedEntity(context, value, path);
  if (entity === null) {
    return null;
  }
  return isTempId(value) ? { kind: "temp", ref: value } : { kind: "key", key: value, entity };
}

/**
 * Which entity type a reference names, reporting the reason when it names none.
 * A temp id has to be declared by a `create` in the same set; anything else has to
 * decode as a key.
 */
function referencedEntity(
  { declared, issues }: OperationContext,
  value: string,
  path: string,
): EntityType | null {
  if (value.startsWith("$")) {
    const entity = declared.get(value);
    if (entity === undefined) {
      issues.push(
        shapeIssue(
          path,
          `${value} is a temp id, but no create in this change set declares it. Give the create the key ${value}, or use an existing entity's key here.`,
        ),
      );
      return null;
    }
    return entity;
  }
  const parsed = parseKey(value);
  if (!parsed) {
    issues.push(
      shapeIssue(
        path,
        `${value} is neither an entity key (EPIC-1, STR-12, TASK-45) nor a temp id from this change set ($new_stream).`,
      ),
    );
    return null;
  }
  return parsed.entity;
}

/** The temp ids an operation cannot run before. */
function pendingRefs(operation: PlannedOperation): readonly string[] {
  const refs: string[] = [];
  const collect = (ref: PlanRef | undefined): void => {
    if (ref?.kind === "temp") {
      refs.push(ref.ref);
    }
  };
  if (operation.kind === "create" || operation.kind === "move") {
    collect(operation.parent);
  }
  if (operation.kind === "link" || operation.kind === "unlink") {
    collect(operation.source);
    collect(operation.target);
  }
  return refs;
}

function orderPlan(planned: readonly PlannedOperation[]): PlanResult {
  const ordered: PlannedOperation[] = [];
  const emitted = new Set<number>();
  const created = new Set<string>();

  while (ordered.length < planned.length) {
    // The *earliest* eligible operation, re-scanned from the front after each
    // one: that is what keeps the reordering minimal instead of pushing every
    // blocked operation to the end of the plan.
    const next = planned.find(
      (operation) =>
        !emitted.has(operation.index) && pendingRefs(operation).every((ref) => created.has(ref)),
    );
    if (!next) {
      // The loop's termination guarantee. It is currently unreachable through
      // `planChangeSet`: only a `create` declares a temp id, a `create` references
      // only its parent, and `parentRef` enforces the one-way pairing
      // task → stream → epic → project, so no two operations can wait on each
      // other. It stays because a `while` loop whose progress is not structurally
      // guaranteed must not be able to spin, and because a later operation that
      // declares a temp id would make it reachable.
      const stuck = planned.filter((operation) => !emitted.has(operation.index));
      return {
        ok: false,
        issues: [
          shapeIssue(
            "operations",
            `Operations ${stuck.map((operation) => operation.index).join(", ")} reference temp ids in a circle, so no order exists in which each one runs after the create it depends on.`,
          ),
        ],
      };
    }
    ordered.push(next);
    emitted.add(next.index);
    if (next.kind === "create" && next.ref !== null) {
      created.add(next.ref);
    }
  }

  return { ok: true, plan: ordered };
}
