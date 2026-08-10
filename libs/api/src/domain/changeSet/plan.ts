import { HIERARCHY_ENTITY_TYPE, LINKABLE_ENTITY_TYPE, type VersionedEntityType } from "../enums";
import { parseVersionedKey } from "../keys";
import { type DocumentIssue, ruleIssue, shapeIssue } from "../schema/rules";
import {
  type ChangeSet,
  type ChangeSetItemMutation,
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
 * change set itself. "Does `S-12` exist?" and "would this close a dependency
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
  | { readonly kind: "key"; readonly key: string; readonly entity: VersionedEntityType }
  | { readonly kind: "temp"; readonly ref: string }
  | { readonly kind: "project"; readonly name: string };

export type PlannedOperation = {
  /** Position in the submitted change set, so an issue or an error can name it. */
  readonly index: number;
} & (
  | {
      readonly kind: "create";
      readonly entity: VersionedEntityType;
      /** The temp id later operations reference, if the author declared one. */
      readonly ref: string | null;
      readonly parent: PlanRef;
      readonly data: Record<string, unknown>;
      readonly roadmapOrder: number | null;
    }
  | {
      readonly kind: "update";
      readonly target: KeyRef;
      readonly expectedRevision: number;
      readonly data: Record<string, unknown> | null;
      readonly items: readonly ChangeSetItemMutation[];
      readonly rebaseStreamRevision: boolean;
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
  | {
      readonly kind: "schedule";
      readonly target: KeyRef | Extract<PlanRef, { kind: "temp" }>;
      /** A temp target uses the revision produced by its earlier create. */
      readonly expectedRevision: number | null;
      readonly milestone: KeyRef | Extract<PlanRef, { kind: "temp" }> | null;
      readonly roadmapRank: number | null;
      readonly roadmapOrder: number | null;
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
  rule: null,
  milestone: null,
} as const satisfies Record<VersionedEntityType, VersionedEntityType | null>;

export function planChangeSet(changeSet: ChangeSet): PlanResult {
  const issues: DocumentIssue[] = [];
  /** Temp id → the entity type the `create` that defines it will produce. */
  const declared = new Map<string, VersionedEntityType>();

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
        parseVersionedKey(operation.key) === null
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
  readonly declared: Map<string, VersionedEntityType>;
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

  // These qualifiers are part of a shared, deliberately flat operation schema,
  // but two shapes cannot use them. An epic already names its project directly
  // in `parent`; and a temp id is unique inside this set, so it cannot be
  // ambiguous across projects. Refuse both instead of accepting a field the
  // executor would silently ignore.
  if (
    operation.operation === "create" &&
    operation.project !== undefined &&
    (operation.entity === "epic" ||
      operation.entity === "rule" ||
      operation.entity === "milestone" ||
      (operation.parent !== undefined && isTempId(operation.parent)))
  ) {
    issues.push(
      shapeIssue(
        `operations[${index}].project`,
        operation.entity === "epic" ||
          operation.entity === "rule" ||
          operation.entity === "milestone"
          ? "project is not used for an Epic, Rule or Milestone create: parent already is the project name."
          : "project is not used when the create parent is a temp id: temp ids are unique within this change set.",
      ),
    );
  }

  if (
    operation.operation === "move" &&
    operation.parent_project !== undefined &&
    ((operation.key !== undefined && parseVersionedKey(operation.key)?.entity === "epic") ||
      (operation.parent !== undefined && isTempId(operation.parent)))
  ) {
    issues.push(
      shapeIssue(
        `operations[${index}].parent_project`,
        operation.key !== undefined && parseVersionedKey(operation.key)?.entity === "epic"
          ? "parent_project is not used when moving an epic: parent already is the new project name."
          : "parent_project is not used when the new parent is a temp id: temp ids are unique within this change set.",
      ),
    );
  }

  if (
    operation.operation === "schedule" &&
    operation.project !== undefined &&
    operation.key !== undefined &&
    isTempId(operation.key)
  ) {
    issues.push(
      shapeIssue(
        `operations[${index}].project`,
        "project is not used when scheduling a temp Stream: temp ids are unique within this change set.",
      ),
    );
  }
}

function buildOperation(context: OperationContext): PlannedOperation | null {
  const { index, operation } = context;
  validateEmbeddedRuleRefs(context);
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
        roadmapOrder: createRoadmapOrder(context, entity),
      };
    }
    case "update": {
      const target = keyRef(context);
      const expectedRevision = requireExpectedRevision(context);
      const payload = requireUpdatePayload(context);
      if (!target || expectedRevision === null || !payload) {
        return null;
      }
      if (payload.rebaseStreamRevision && target.entity !== "task") {
        context.issues.push(
          shapeIssue(
            `operations[${index}].rebase_stream_revision`,
            "Only a Task captures and rebases a parent Stream revision.",
          ),
        );
        return null;
      }
      return { index, kind: "update", target, expectedRevision, ...payload };
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
      if (!(HIERARCHY_ENTITY_TYPE as readonly string[]).includes(target.entity)) {
        context.issues.push(
          shapeIssue(
            `operations[${index}].key`,
            `${target.key} is a ${target.entity}; only Epics, Streams and Tasks have movable parents.`,
          ),
        );
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
    case "schedule": {
      return buildSchedule(context);
    }
  }
}

function createRoadmapOrder(
  { index, operation, issues }: OperationContext,
  entity: VersionedEntityType,
): number | null {
  if (entity === "milestone") {
    if (operation.roadmap_order === undefined) {
      issues.push(
        shapeIssue(
          `operations[${index}].roadmap_order`,
          "Creating a Milestone needs its advisory roadmap_order; equal values are allowed.",
        ),
      );
      return null;
    }
    return operation.roadmap_order;
  }
  if (operation.roadmap_order !== undefined) {
    issues.push(
      shapeIssue(
        `operations[${index}].roadmap_order`,
        "roadmap_order is used only when creating or scheduling a Milestone.",
      ),
    );
  }
  return null;
}

function buildSchedule(context: OperationContext): PlannedOperation | null {
  const { index, operation, issues } = context;
  const target = scheduleTargetRef(context);
  if (target === null) return null;
  const expectedRevision = target.ref.kind === "temp" ? null : requireExpectedRevision(context);
  if (target.ref.kind === "key" && expectedRevision === null) return null;

  if (target.entity === "milestone") {
    if (operation.roadmap_order === undefined) {
      issues.push(
        shapeIssue(
          `operations[${index}].roadmap_order`,
          "Scheduling a Milestone needs roadmap_order.",
        ),
      );
      return null;
    }
    if (operation.milestone !== undefined || operation.roadmap_rank !== undefined) {
      issues.push(
        shapeIssue(
          `operations[${index}]`,
          "A Milestone schedule uses roadmap_order, not milestone or roadmap_rank.",
        ),
      );
      return null;
    }
    return {
      index,
      kind: "schedule",
      target: target.ref,
      expectedRevision,
      milestone: null,
      roadmapRank: null,
      roadmapOrder: operation.roadmap_order,
    };
  }

  if (target.entity !== "stream") {
    issues.push(
      shapeIssue(
        `operations[${index}].key`,
        "schedule acts on a Stream placement or a Milestone order.",
      ),
    );
    return null;
  }
  if (!Object.hasOwn(operation, "milestone")) {
    issues.push(
      shapeIssue(
        `operations[${index}].milestone`,
        "Scheduling a Stream needs a Milestone key, or null to return it to Backlog.",
      ),
    );
    return null;
  }
  if (operation.roadmap_order !== undefined) {
    issues.push(
      shapeIssue(
        `operations[${index}].roadmap_order`,
        "A Stream schedule uses roadmap_rank, not roadmap_order.",
      ),
    );
    return null;
  }
  if (operation.milestone === null) {
    if (operation.roadmap_rank !== undefined && operation.roadmap_rank !== null) {
      issues.push(
        shapeIssue(
          `operations[${index}].roadmap_rank`,
          "An unscheduled Backlog Stream has no roadmap_rank.",
        ),
      );
      return null;
    }
    return {
      index,
      kind: "schedule",
      target: target.ref,
      expectedRevision,
      milestone: null,
      roadmapRank: null,
      roadmapOrder: null,
    };
  }
  if (operation.milestone === undefined || operation.roadmap_rank == null) {
    issues.push(
      shapeIssue(
        `operations[${index}].roadmap_rank`,
        "A Stream assigned to a Milestone needs roadmap_rank; equal ranks mean parallel work.",
      ),
    );
    return null;
  }
  const milestoneEntity = referencedEntity(
    context,
    operation.milestone,
    `operations[${index}].milestone`,
  );
  if (milestoneEntity === null) return null;
  if (milestoneEntity !== "milestone") {
    issues.push(
      shapeIssue(`operations[${index}].milestone`, `${operation.milestone} is not a Milestone.`),
    );
    return null;
  }
  const milestone: KeyRef | Extract<PlanRef, { kind: "temp" }> = isTempId(operation.milestone)
    ? { kind: "temp", ref: operation.milestone }
    : { kind: "key", key: operation.milestone, entity: "milestone" };
  return {
    index,
    kind: "schedule",
    target: target.ref,
    expectedRevision,
    milestone,
    roadmapRank: operation.roadmap_rank,
    roadmapOrder: null,
  };
}

/**
 * A Stream created earlier in the same atomic set may be placed immediately.
 * Its revision is known from the simulated create, so asking the caller to
 * invent `expected_revision: 1` would add a round trip without adding OCC.
 */
function scheduleTargetRef(context: OperationContext): {
  readonly ref: KeyRef | Extract<PlanRef, { kind: "temp" }>;
  readonly entity: "stream" | "milestone";
} | null {
  const { index, operation, issues } = context;
  const path = `operations[${index}].key`;
  if (operation.key === undefined) {
    issues.push(shapeIssue(path, "schedule needs key: a Stream or Milestone key."));
    return null;
  }
  const entity = referencedEntity(context, operation.key, path);
  if (entity === null) return null;
  if (entity !== "stream" && entity !== "milestone") {
    issues.push(shapeIssue(path, "schedule acts on a Stream placement or a Milestone order."));
    return null;
  }
  if (isTempId(operation.key)) {
    if (entity !== "stream") {
      issues.push(
        shapeIssue(
          path,
          "A new Milestone already receives roadmap_order on create; only a newly created Stream needs a later schedule operation.",
        ),
      );
      return null;
    }
    if (operation.expected_revision !== undefined) {
      issues.push(
        shapeIssue(
          `operations[${index}].expected_revision`,
          "Do not send expected_revision for a temp Stream. Its current revision comes from the earlier create in this same atomic change set.",
        ),
      );
      return null;
    }
    return { ref: { kind: "temp", ref: operation.key }, entity };
  }
  const parsed = parseVersionedKey(operation.key);
  if (parsed === null || (parsed.entity !== "stream" && parsed.entity !== "milestone")) {
    return null;
  }
  return { ref: { kind: "key", key: operation.key, entity: parsed.entity }, entity: parsed.entity };
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

function requireUpdatePayload({ index, operation, issues }: OperationContext): {
  readonly data: Record<string, unknown> | null;
  readonly items: readonly ChangeSetItemMutation[];
  readonly rebaseStreamRevision: boolean;
} | null {
  const data =
    operation.data !== undefined && Object.keys(operation.data).length > 0 ? operation.data : null;
  const items = operation.items ?? [];
  const rebaseStreamRevision = operation.rebase_stream_revision === true;
  if (data === null && items.length === 0 && !rebaseStreamRevision) {
    issues.push(
      shapeIssue(
        `operations[${index}]`,
        "update needs data, items, rebase_stream_revision: true, or a combination. data replaces document sections; items edits complete id-bearing elements.",
      ),
    );
    return null;
  }

  items.forEach((item, itemIndex) => {
    const path = `operations[${index}].items[${itemIndex}]`;
    if (item.action === "remove") {
      if (item.value !== undefined) {
        issues.push(shapeIssue(`${path}.value`, "remove does not use value."));
      }
      return;
    }
    if (item.value === undefined) {
      issues.push(shapeIssue(`${path}.value`, `${item.action} needs the complete element value.`));
      return;
    }
    if (item.value.id !== item.id) {
      issues.push(
        shapeIssue(
          `${path}.value.id`,
          `The complete element id must equal ${item.id}; item replacement cannot rename identity.`,
        ),
      );
    }
  });
  return { data, items, rebaseStreamRevision };
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
  const parsed = parseVersionedKey(operation.key);
  if (!parsed) {
    issues.push(
      shapeIssue(
        path,
        `${operation.key} is not an entity key. Keys look like E-1, S-12, T-45, M-2 or R-7.`,
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
function parentRef(context: OperationContext, entity: VersionedEntityType): PlanRef | null {
  const { index, operation, issues } = context;
  const path = `operations[${index}].parent`;
  const expected = PARENT_ENTITY[entity];

  if (operation.parent === undefined) {
    issues.push(
      shapeIssue(
        path,
        expected === null
          ? `${operation.operation} of a ${entity} needs parent: the name of the project it belongs to.`
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
          `A ${entity}'s parent is a project, named by its project name. A change set cannot create a project.`,
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
  if (!(LINKABLE_ENTITY_TYPE as readonly string[]).includes(entity)) {
    issues.push(
      shapeIssue(
        path,
        `${value} is a ${entity}; Milestones are roadmap overlays, not graph endpoints.`,
      ),
    );
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
): VersionedEntityType | null {
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
  const parsed = parseVersionedKey(value);
  if (!parsed) {
    issues.push(
      shapeIssue(
        path,
        `${value} is neither an entity key (E-1, S-12, T-45, M-2, R-7) nor a temp id from this change set ($new_stream).`,
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
  if (operation.kind === "schedule" && operation.milestone !== null) {
    collect(operation.target);
    collect(operation.milestone);
  } else if (operation.kind === "schedule") {
    collect(operation.target);
  }
  if (operation.kind === "create") {
    refs.push(...embeddedRuleTempRefs(operation.data));
  }
  if (operation.kind === "update") {
    if (operation.data !== null) refs.push(...embeddedRuleTempRefs(operation.data));
    refs.push(...operation.items.flatMap((item) => embeddedRuleTempRefs(item.value)));
  }
  return [...new Set(refs)];
}

const RULE_REFERENCE_FIELDS = new Set(["rule_key", "rule_keys", "constrained_by_rule_keys"]);

function embeddedRuleTempRefs(value: unknown): readonly string[] {
  if (Array.isArray(value)) {
    return value.flatMap(embeddedRuleTempRefs);
  }
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => {
    if (!RULE_REFERENCE_FIELDS.has(key)) return embeddedRuleTempRefs(child);
    if (typeof child === "string") return isTempId(child) ? [child] : [];
    return Array.isArray(child)
      ? child.filter((item): item is string => typeof item === "string" && isTempId(item))
      : [];
  });
}

function validateEmbeddedRuleRefs({ index, operation, declared, issues }: OperationContext): void {
  const refs = [
    ...(operation.data === undefined ? [] : embeddedRuleTempRefs(operation.data)),
    ...(operation.items ?? []).flatMap((item) => embeddedRuleTempRefs(item.value)),
  ];
  for (const ref of new Set(refs)) {
    const entity = declared.get(ref);
    if (entity === undefined) {
      issues.push(
        shapeIssue(
          `operations[${index}].data`,
          `${ref} is used as a Rule reference, but no create in this change set declares it.`,
        ),
      );
    } else if (entity !== "rule") {
      issues.push(
        shapeIssue(
          `operations[${index}].data`,
          `${ref} is used as a Rule reference, but it declares a ${entity}.`,
        ),
      );
    }
  }
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
