/// <reference types="node" />

import { createHash } from "node:crypto";
import type {
  CurrentEntitySnapshot,
  DatabaseSnapshot,
  HierarchyEntityType,
  LinkSnapshot,
  ProjectSnapshot,
  RevisionSnapshot,
} from "./readSnapshot";

type JsonPrimitive = boolean | number | string | null;
type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export type MigrationFinding = {
  readonly code: string;
  readonly project_id: string | null;
  readonly entity_type?: string;
  readonly entity_id?: string;
  readonly entity_key?: string;
  readonly path?: string;
  readonly message: string;
  readonly details?: JsonValue;
};

export type EntityKeyMapping = {
  readonly entity_type: HierarchyEntityType;
  readonly entity_id: string;
  readonly legacy_key: string;
  readonly v2_key: string | null;
  readonly sequence: number | null;
};

export type LocalIdMapping = {
  readonly entity_type: HierarchyEntityType;
  readonly entity_id: string;
  readonly entity_key: string;
  readonly namespace: string;
  readonly namespace_owner: string;
  readonly source_path: string;
  readonly target_path: string;
  readonly legacy_id: string | null;
  readonly v2_id: string | null;
  readonly strategy:
    | "preserved"
    | "normalized"
    | "allocated"
    | "allocated_after_collision"
    | "blocked";
};

export type RuleOccurrence = {
  readonly owner_type: "epic" | "stream";
  readonly owner_id: string;
  readonly owner_key: string;
  readonly path: string;
  readonly legacy_id: string | null;
  readonly content_sha256: string;
  readonly content: JsonValue;
};

export type RuleGroup = {
  readonly legacy_id: string;
  readonly content_sha256: string;
  readonly proposed_rule_key: string | null;
  readonly occurrences: readonly RuleOccurrence[];
};

export type RuleMergeCandidate = {
  readonly content_sha256: string;
  readonly legacy_ids: readonly string[];
  readonly occurrence_count: number;
};

export type RuleApplicationMapping = {
  readonly owner_type: "epic" | "stream";
  readonly owner_id: string;
  readonly owner_key: string;
  readonly source_path: string;
  readonly application_id: string | null;
  readonly legacy_rule_id: string | null;
  readonly rule_key: string | null;
};

export type StructuredReference = {
  readonly owner_type: HierarchyEntityType;
  readonly owner_id: string;
  readonly owner_key: string;
  readonly path: string;
  readonly kind: string;
  readonly legacy_value: string;
  readonly v2_value: string | null;
  readonly resolution: "ambiguous" | "resolved" | "unchanged" | "unresolved";
};

export type ProseMention = {
  readonly owner_type: HierarchyEntityType;
  readonly owner_id: string;
  readonly owner_key: string;
  readonly path: string;
  readonly token: string;
  readonly classification: "entity_key" | "local_id" | "rule_id" | "unknown";
  readonly mapped_to: readonly string[];
};

export type RowHash = {
  readonly identity: string;
  readonly document_sha256?: string;
  readonly row_sha256: string;
};

export type ProjectPreflightReport = {
  readonly workspace_id: string;
  readonly project_id: string;
  readonly project_name: string;
  readonly counters: {
    readonly stored: {
      readonly epic: number;
      readonly stream: number;
      readonly task: number;
      readonly milestone: number | null;
      readonly rule: number | null;
    };
    readonly observed_max: Record<"epic" | "milestone" | "rule" | "stream" | "task", number>;
    readonly required_after_cutover: Record<
      "epic" | "milestone" | "rule" | "stream" | "task",
      number
    >;
  };
  readonly counts: {
    readonly current: Record<"epic" | "milestone" | "rule" | "stream" | "task", number>;
    readonly revisions: Readonly<Record<string, number>>;
    readonly links: number;
  };
  readonly key_mappings: readonly EntityKeyMapping[];
  readonly local_id_mappings: readonly LocalIdMapping[];
  readonly rules: {
    readonly occurrences: readonly RuleOccurrence[];
    readonly groups: readonly RuleGroup[];
    readonly same_content_different_id_candidates: readonly RuleMergeCandidate[];
    readonly applications: readonly RuleApplicationMapping[];
  };
  readonly structured_references: readonly StructuredReference[];
  readonly prose_mentions: readonly ProseMention[];
  readonly audit: {
    readonly project_row_sha256: string;
    readonly current_rows: readonly RowHash[];
    readonly current_rows_sha256: string;
    readonly revision_rows: readonly RowHash[];
    readonly revision_rows_sha256: string;
    readonly link_rows: readonly RowHash[];
    readonly link_rows_sha256: string;
  };
  readonly conflicts: readonly MigrationFinding[];
  readonly warnings: readonly MigrationFinding[];
};

export type V2PreflightReport = {
  readonly report_version: "zpecs.v2.preflight.v1";
  readonly target_schema_versions: {
    readonly epic: "pm.epic.v2";
    readonly stream: "pm.stream.v2";
    readonly task: "pm.task.v2";
    readonly rule: "pm.rule.v2";
    readonly milestone: "pm.milestone.v2";
  };
  readonly deterministic: true;
  readonly writes_performed: false;
  readonly database_capabilities: DatabaseSnapshot["capabilities"];
  readonly apply: {
    readonly status: "not_ready";
    readonly reason: string;
  };
  readonly summary: {
    readonly projects: number;
    readonly current_entities: number;
    readonly revisions: number;
    readonly links: number;
    readonly conflicts: number;
    readonly warnings: number;
  };
  readonly projects: readonly ProjectPreflightReport[];
  readonly conflicts: readonly MigrationFinding[];
  readonly warnings: readonly MigrationFinding[];
};

type ObjectValue = Record<string, unknown>;

const textOrder = (left: string, right: string): number =>
  left === right ? 0 : left < right ? -1 : 1;

const numberedTextOrder = (left: string, right: string): number => {
  const leftMatch = /^(.*?)([0-9]+)$/.exec(left);
  const rightMatch = /^(.*?)([0-9]+)$/.exec(right);
  if (leftMatch && rightMatch && leftMatch[1] === rightMatch[1]) {
    return Number(leftMatch[2]) - Number(rightMatch[2]) || textOrder(left, right);
  }
  return textOrder(left, right);
};

const recordOf = (value: unknown): ObjectValue =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as ObjectValue)
    : {};

const arrayOf = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);

const atPath = (value: unknown, path: readonly string[]): unknown => {
  let current = value;
  for (const segment of path) {
    if (Array.isArray(current)) {
      const index = Number(segment);
      current = Number.isSafeInteger(index) ? current[index] : undefined;
    } else {
      current = recordOf(current)[segment];
    }
  }
  return current;
};

const canonicalValue = (value: unknown): JsonValue => {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Cannot canonicalize a non-finite JSON number.");
    return value;
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as ObjectValue)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => textOrder(left, right))
        .map(([key, child]) => [key, canonicalValue(child)]),
    );
  }
  throw new Error(`Cannot canonicalize ${typeof value}.`);
};

/** Stable JSON used both for output ordering and for reproducible audit hashes. */
export const canonicalJson = (value: unknown): string => JSON.stringify(canonicalValue(value));

export const sha256 = (value: unknown): string =>
  createHash("sha256").update(canonicalJson(value)).digest("hex");

const findingOrder = (left: MigrationFinding, right: MigrationFinding): number =>
  textOrder(left.project_id ?? "", right.project_id ?? "") ||
  textOrder(left.entity_type ?? "", right.entity_type ?? "") ||
  numberedTextOrder(left.entity_key ?? "", right.entity_key ?? "") ||
  textOrder(left.path ?? "", right.path ?? "") ||
  textOrder(left.code, right.code) ||
  textOrder(left.message, right.message);

const finding = (
  code: string,
  projectId: string | null,
  message: string,
  context: Partial<Omit<MigrationFinding, "code" | "message" | "project_id">> = {},
): MigrationFinding => ({ code, project_id: projectId, message, ...context });

const ENTITY_ORDER: Record<string, number> = {
  epic: 0,
  stream: 1,
  task: 2,
  milestone: 3,
  rule: 4,
};

const entityOrder = (left: CurrentEntitySnapshot, right: CurrentEntitySnapshot): number =>
  (ENTITY_ORDER[left.entity_type] ?? 99) - (ENTITY_ORDER[right.entity_type] ?? 99) ||
  numberedTextOrder(left.key, right.key) ||
  textOrder(left.id, right.id);

const hierarchyEntity = (
  row: CurrentEntitySnapshot,
): row is CurrentEntitySnapshot & { readonly entity_type: HierarchyEntityType } =>
  row.entity_type === "epic" || row.entity_type === "stream" || row.entity_type === "task";

const countsBy = <Value extends string>(
  values: readonly Value[],
): Readonly<Record<Value, number>> => {
  const counts = {} as Record<Value, number>;
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
};

const ENTITY_KEY_PREFIX = {
  epic: { legacy: ["EPIC", "E"], v2: "E" },
  stream: { legacy: ["STR", "S"], v2: "S" },
  task: { legacy: ["TASK", "T"], v2: "T" },
} as const;

const parseNumberedKey = (value: string, prefixes: readonly string[]): number | null => {
  const match = /^([A-Z]+)-([1-9][0-9]*)$/.exec(value);
  return match && prefixes.includes(match[1] ?? "") ? Number(match[2]) : null;
};

type LocalCandidate = {
  readonly owner: CurrentEntitySnapshot & { readonly entity_type: HierarchyEntityType };
  readonly namespace: string;
  readonly namespaceOwner: string;
  readonly prefix: string;
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly legacyId: string | null;
  readonly requiresLegacyId: boolean;
  readonly order: number;
};

type LocalCollection = {
  readonly path: readonly string[];
  readonly prefix: string;
  readonly namespace: string;
  readonly targetPath?: readonly string[];
  readonly targetIndexOffset?: number;
  readonly requiresLegacyId?: boolean;
};

const addCollection = (
  candidates: LocalCandidate[],
  owner: LocalCandidate["owner"],
  collection: LocalCollection,
  namespaceOwner = collection.namespace,
): void => {
  const values = arrayOf(atPath(owner.document, collection.path));
  const target = collection.targetPath ?? collection.path;
  values.forEach((value, index) => {
    const id = recordOf(value).id;
    candidates.push({
      owner,
      namespace: collection.namespace,
      namespaceOwner,
      prefix: collection.prefix,
      sourcePath: `${collection.path.join(".")}[${String(index)}]`,
      targetPath: `${target.join(".")}[${String(index + (collection.targetIndexOffset ?? 0))}]`,
      legacyId: typeof id === "string" ? id : null,
      requiresLegacyId: collection.requiresLegacyId ?? true,
      order: candidates.length,
    });
  });
};

const addScope = (
  candidates: LocalCandidate[],
  owner: LocalCandidate["owner"],
  path: readonly string[],
): void => {
  addCollection(candidates, owner, {
    path: [...path, "included"],
    prefix: "SCP",
    namespace: "scope",
  });
  addCollection(candidates, owner, {
    path: [...path, "excluded"],
    prefix: "SCP",
    namespace: "scope",
  });
};

const collectLocalCandidates = (
  entities: readonly (CurrentEntitySnapshot & { readonly entity_type: HierarchyEntityType })[],
): readonly LocalCandidate[] => {
  const candidates: LocalCandidate[] = [];
  for (const owner of entities) {
    const contentOpenQuestionCount = arrayOf(
      atPath(owner.document, ["content", "open_questions"]),
    ).length;
    const contentAssumptionCount = arrayOf(
      atPath(owner.document, ["content", "assumptions"]),
    ).length;
    addCollection(candidates, owner, {
      path: ["provenance", "sources"],
      prefix: "SRC",
      namespace: "sources",
      requiresLegacyId: false,
    });
    addCollection(candidates, owner, {
      path: ["content", "open_questions"],
      prefix: "OQ",
      namespace: "open_questions",
      requiresLegacyId: false,
    });
    addCollection(candidates, owner, {
      path: ["provenance", "open_questions"],
      targetPath: ["content", "open_questions"],
      targetIndexOffset: contentOpenQuestionCount,
      prefix: "OQ",
      namespace: "open_questions",
      requiresLegacyId: false,
    });
    addCollection(candidates, owner, {
      path: ["content", "assumptions"],
      prefix: "ASM",
      namespace: "assumptions",
      requiresLegacyId: false,
    });
    addCollection(candidates, owner, {
      path: ["provenance", "assumptions"],
      targetPath: ["content", "assumptions"],
      targetIndexOffset: contentAssumptionCount,
      prefix: "ASM",
      namespace: "assumptions",
      requiresLegacyId: false,
    });

    if (owner.entity_type === "task") {
      addCollection(candidates, owner, {
        path: ["content", "verification"],
        prefix: "VER",
        namespace: "verification",
      });
      continue;
    }

    addScope(candidates, owner, ["content", "scope"]);
    addCollection(candidates, owner, {
      path: ["content", "rule_applications"],
      prefix: "RA",
      namespace: "rule_applications",
    });
    addCollection(candidates, owner, {
      path: ["content", "business_rules"],
      targetPath: ["content", "rule_applications"],
      prefix: "RA",
      namespace: "rule_applications",
    });

    if (owner.entity_type === "epic") {
      addCollection(candidates, owner, {
        path: ["content", "outcomes"],
        prefix: "OUT",
        namespace: "outcomes",
      });
      addCollection(candidates, owner, {
        path: ["content", "success_metrics"],
        prefix: "MET",
        namespace: "success_metrics",
      });
      continue;
    }

    addCollection(candidates, owner, {
      path: ["content", "workflows"],
      prefix: "WF",
      namespace: "workflows",
    });
    arrayOf(atPath(owner.document, ["content", "workflows"])).forEach((_, workflowIndex) => {
      addCollection(candidates, owner, {
        path: ["content", "workflows", String(workflowIndex), "steps"],
        prefix: "STEP",
        namespace: "workflow_steps",
      });
    });
    addCollection(candidates, owner, {
      path: ["content", "edge_cases"],
      prefix: "EC",
      namespace: "edge_cases",
    });

    switch (owner.subtype) {
      case "feature": {
        addCollection(candidates, owner, {
          path: ["content", "requirements", "functional"],
          prefix: "FR",
          namespace: "requirements",
        });
        addCollection(candidates, owner, {
          path: ["content", "requirements", "non_functional"],
          prefix: "NFR",
          namespace: "requirements",
        });
        addCollection(candidates, owner, {
          path: ["content", "acceptance_criteria"],
          prefix: "AC",
          namespace: "acceptance_criteria",
        });
        break;
      }
      case "bug": {
        const behaviorCases = arrayOf(atPath(owner.document, ["content", "behavior_cases"]));
        const content = recordOf(owner.document.content);
        const hasLegacyBehavior = [
          content.reproduction,
          content.actual_behavior,
          content.expected_behavior,
          content.severity,
        ].some((value) => value !== undefined);
        if (behaviorCases.length > 0) {
          addCollection(candidates, owner, {
            path: ["content", "behavior_cases"],
            prefix: "BC",
            namespace: "behavior_cases",
          });
        }
        if (hasLegacyBehavior) {
          candidates.push({
            owner,
            namespace: "behavior_cases",
            namespaceOwner: "behavior_cases",
            prefix: "BC",
            sourcePath: "content.{reproduction,actual_behavior,expected_behavior,severity}",
            targetPath: "content.behavior_cases[0]",
            legacyId: null,
            requiresLegacyId: false,
            order: candidates.length,
          });
        }
        break;
      }
      case "change":
        addCollection(candidates, owner, {
          path: ["content", "changes"],
          prefix: "CHG",
          namespace: "changes",
        });
        break;
      case "experiment":
        for (const collection of [
          { path: "hypotheses", prefix: "HYP" },
          { path: "research_questions", prefix: "RQ" },
          { path: "success_criteria", prefix: "SC" },
          { path: "decision_rules", prefix: "DR" },
        ] as const) {
          addCollection(candidates, owner, {
            path: ["content", collection.path],
            prefix: collection.prefix,
            namespace: collection.path,
          });
        }
        break;
      case "investigation":
        addScope(candidates, owner, ["content", "discovery_scope"]);
        addCollection(candidates, owner, {
          path: ["content", "questions"],
          prefix: "IQ",
          namespace: "investigation_questions",
        });
        addCollection(candidates, owner, {
          path: ["content", "success_criteria"],
          prefix: "SC",
          namespace: "success_criteria",
        });
        break;
      case "refactor":
        for (const collection of [
          { path: "refactor_targets", prefix: "REF" },
          { path: "invariants", prefix: "INV" },
          { path: "quality_goals", prefix: "QG" },
        ] as const) {
          addCollection(candidates, owner, {
            path: ["content", collection.path],
            prefix: collection.prefix,
            namespace: collection.path,
          });
        }
        break;
      case "maintenance":
        addCollection(candidates, owner, {
          path: ["content", "maintenance_goals"],
          prefix: "MG",
          namespace: "maintenance_goals",
        });
        addCollection(candidates, owner, {
          path: ["content", "risks"],
          prefix: "RSK",
          namespace: "risks",
        });
        break;
    }
  }
  return candidates;
};

const trailingSequence = (value: string | null): number | null => {
  if (value === null) return null;
  const match = /(?:^|-)([0-9]+)$/.exec(value);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};

const allocateLocalIds = (
  candidates: readonly LocalCandidate[],
  conflicts: MigrationFinding[],
  warnings: MigrationFinding[],
): readonly LocalIdMapping[] => {
  const byOwnerNamespace = new Map<string, LocalCandidate[]>();
  for (const candidate of candidates) {
    const key = `${candidate.owner.id}\u0000${candidate.namespaceOwner}`;
    const group = byOwnerNamespace.get(key) ?? [];
    group.push(candidate);
    byOwnerNamespace.set(key, group);
  }

  const mappings: LocalIdMapping[] = [];
  for (const group of byOwnerNamespace.values()) {
    group.sort((left, right) => left.order - right.order);
    const duplicateLegacyIds = new Set<string>();
    const candidatesByLegacyId = new Map<string, LocalCandidate[]>();
    for (const candidate of group) {
      if (candidate.legacyId === null) continue;
      const matching = candidatesByLegacyId.get(candidate.legacyId) ?? [];
      matching.push(candidate);
      candidatesByLegacyId.set(candidate.legacyId, matching);
    }
    for (const [legacyId, matching] of candidatesByLegacyId) {
      if (matching.length < 2) continue;
      duplicateLegacyIds.add(legacyId);
      const first = matching[0];
      if (!first) continue;
      conflicts.push(
        finding(
          "duplicate_local_id",
          first.owner.project_id,
          `${legacyId} occurs ${String(matching.length)} times in one local semantic namespace.`,
          {
            entity_type: first.owner.entity_type,
            entity_id: first.owner.id,
            entity_key: first.owner.key,
            path: first.namespaceOwner,
            details: matching.map((candidate) => candidate.sourcePath),
          },
        ),
      );
    }

    const usedByPrefix = new Map<string, Set<number>>();
    for (const candidate of group) {
      const blocked =
        (candidate.requiresLegacyId && candidate.legacyId === null) ||
        (candidate.legacyId !== null && duplicateLegacyIds.has(candidate.legacyId));
      if (candidate.requiresLegacyId && candidate.legacyId === null) {
        conflicts.push(
          finding(
            "missing_local_id",
            candidate.owner.project_id,
            "An addressable legacy object has no string id and cannot be referenced safely.",
            {
              entity_type: candidate.owner.entity_type,
              entity_id: candidate.owner.id,
              entity_key: candidate.owner.key,
              path: candidate.sourcePath,
            },
          ),
        );
      }
      if (blocked) {
        mappings.push({
          entity_type: candidate.owner.entity_type,
          entity_id: candidate.owner.id,
          entity_key: candidate.owner.key,
          namespace: candidate.namespace,
          namespace_owner: candidate.namespaceOwner,
          source_path: candidate.sourcePath,
          target_path: candidate.targetPath,
          legacy_id: candidate.legacyId,
          v2_id: null,
          strategy: "blocked",
        });
        continue;
      }

      const used = usedByPrefix.get(candidate.prefix) ?? new Set<number>();
      usedByPrefix.set(candidate.prefix, used);
      const desired = trailingSequence(candidate.legacyId);
      let sequence = desired;
      let strategy: LocalIdMapping["strategy"];
      if (sequence !== null && !used.has(sequence)) {
        strategy =
          candidate.legacyId === `${candidate.prefix}-${String(sequence)}`
            ? "preserved"
            : "normalized";
      } else {
        sequence = 1;
        while (used.has(sequence)) sequence += 1;
        strategy = desired === null ? "allocated" : "allocated_after_collision";
        if (desired !== null) {
          warnings.push(
            finding(
              "local_id_numeric_collision",
              candidate.owner.project_id,
              `${candidate.legacyId ?? candidate.sourcePath} could not keep numeric component ${String(desired)} and was deterministically reallocated.`,
              {
                entity_type: candidate.owner.entity_type,
                entity_id: candidate.owner.id,
                entity_key: candidate.owner.key,
                path: candidate.sourcePath,
              },
            ),
          );
        }
      }
      used.add(sequence);
      mappings.push({
        entity_type: candidate.owner.entity_type,
        entity_id: candidate.owner.id,
        entity_key: candidate.owner.key,
        namespace: candidate.namespace,
        namespace_owner: candidate.namespaceOwner,
        source_path: candidate.sourcePath,
        target_path: candidate.targetPath,
        legacy_id: candidate.legacyId,
        v2_id: `${candidate.prefix}-${String(sequence)}`,
        strategy,
      });
    }
  }
  return mappings.sort(
    (left, right) =>
      (ENTITY_ORDER[left.entity_type] ?? 99) - (ENTITY_ORDER[right.entity_type] ?? 99) ||
      numberedTextOrder(left.entity_key, right.entity_key) ||
      textOrder(left.namespace_owner, right.namespace_owner) ||
      textOrder(left.source_path, right.source_path),
  );
};

type InternalRuleOccurrence = RuleOccurrence & {
  readonly canonicalBody: string;
};

const collectRuleOccurrences = (
  entities: readonly (CurrentEntitySnapshot & { readonly entity_type: HierarchyEntityType })[],
  conflicts: MigrationFinding[],
): readonly InternalRuleOccurrence[] => {
  const occurrences: InternalRuleOccurrence[] = [];
  for (const owner of entities) {
    const ownerType =
      owner.entity_type === "epic" ? "epic" : owner.entity_type === "stream" ? "stream" : null;
    if (ownerType === null) continue;
    const rules = arrayOf(atPath(owner.document, ["content", "business_rules"]));
    const applications = arrayOf(atPath(owner.document, ["content", "rule_applications"]));
    if (rules.length > 0 && applications.length > 0) {
      conflicts.push(
        finding(
          "mixed_rule_storage",
          owner.project_id,
          "The document contains both legacy business_rules and v2 rule_applications.",
          {
            entity_type: owner.entity_type,
            entity_id: owner.id,
            entity_key: owner.key,
            path: "content",
          },
        ),
      );
    }
    rules.forEach((value, index) => {
      const rule = recordOf(value);
      const legacyId = typeof rule.id === "string" ? rule.id : null;
      const body = Object.fromEntries(Object.entries(rule).filter(([key]) => key !== "id"));
      const content = canonicalValue(body);
      const canonicalBody = canonicalJson(content);
      occurrences.push({
        owner_type: ownerType,
        owner_id: owner.id,
        owner_key: owner.key,
        path: `content.business_rules[${String(index)}]`,
        legacy_id: legacyId,
        content_sha256: sha256(content),
        content,
        canonicalBody,
      });
      if (legacyId === null) {
        conflicts.push(
          finding(
            "missing_rule_id",
            owner.project_id,
            "An inline business Rule has no string id.",
            {
              entity_type: owner.entity_type,
              entity_id: owner.id,
              entity_key: owner.key,
              path: `content.business_rules[${String(index)}].id`,
            },
          ),
        );
      }
    });
  }
  return occurrences.sort(
    (left, right) =>
      (ENTITY_ORDER[left.owner_type] ?? 99) - (ENTITY_ORDER[right.owner_type] ?? 99) ||
      numberedTextOrder(left.owner_key, right.owner_key) ||
      textOrder(left.path, right.path),
  );
};

type RuleInventory = {
  readonly occurrences: readonly InternalRuleOccurrence[];
  readonly groups: readonly RuleGroup[];
  readonly candidates: readonly RuleMergeCandidate[];
  readonly nextSequence: number;
};

const buildRuleInventory = (
  project: ProjectSnapshot,
  entities: readonly CurrentEntitySnapshot[],
  hierarchy: readonly (CurrentEntitySnapshot & { readonly entity_type: HierarchyEntityType })[],
  conflicts: MigrationFinding[],
): RuleInventory => {
  const occurrences = collectRuleOccurrences(hierarchy, conflicts);
  const existingRules = entities.filter((entity) => entity.entity_type === "rule");
  if (existingRules.length > 0 && occurrences.length > 0) {
    conflicts.push(
      finding(
        "preexisting_rules_need_reconciliation",
        project.id,
        "The Project contains both canonical Rule rows and inline legacy Rules; no automatic ownership assumption is safe.",
        {
          path: "rules",
          details: existingRules.map((rule) => rule.key),
        },
      ),
    );
  }
  const byLegacyId = new Map<string, InternalRuleOccurrence[]>();
  for (const occurrence of occurrences) {
    if (occurrence.legacy_id === null) continue;
    const group = byLegacyId.get(occurrence.legacy_id) ?? [];
    group.push(occurrence);
    byLegacyId.set(occurrence.legacy_id, group);
  }

  const divergentIds = new Set<string>();
  for (const [legacyId, matching] of byLegacyId) {
    const variants = new Map<string, InternalRuleOccurrence[]>();
    for (const occurrence of matching) {
      const variant = variants.get(occurrence.canonicalBody) ?? [];
      variant.push(occurrence);
      variants.set(occurrence.canonicalBody, variant);
    }
    if (variants.size < 2) continue;
    divergentIds.add(legacyId);
    conflicts.push(
      finding(
        "same_rule_id_different_content",
        project.id,
        `${legacyId} has ${String(variants.size)} different complete bodies and must be resolved by a human.`,
        {
          path: `rules.${legacyId}`,
          details: [...variants.values()].map((variant) => ({
            content_sha256: variant[0]?.content_sha256 ?? "",
            occurrences: variant.map((item) => `${item.owner_key}:${item.path}`),
          })),
        },
      ),
    );
  }

  const existingRuleMax = Math.max(
    0,
    ...entities
      .filter((entity) => entity.entity_type === "rule")
      .map((entity) => parseNumberedKey(entity.key, ["R"]) ?? 0),
  );
  let sequence = Math.max(project.rule_counter ?? 0, existingRuleMax);
  const groups: RuleGroup[] = [];
  for (const [legacyId, matching] of [...byLegacyId].sort(([left], [right]) =>
    numberedTextOrder(left, right),
  )) {
    const byBody = new Map<string, InternalRuleOccurrence[]>();
    for (const occurrence of matching) {
      const bodyGroup = byBody.get(occurrence.canonicalBody) ?? [];
      bodyGroup.push(occurrence);
      byBody.set(occurrence.canonicalBody, bodyGroup);
    }
    for (const bodyGroup of [...byBody.values()].sort((left, right) =>
      textOrder(left[0]?.content_sha256 ?? "", right[0]?.content_sha256 ?? ""),
    )) {
      const first = bodyGroup[0];
      if (!first) continue;
      const proposed = divergentIds.has(legacyId) ? null : `R-${String((sequence += 1))}`;
      groups.push({
        legacy_id: legacyId,
        content_sha256: first.content_sha256,
        proposed_rule_key: proposed,
        occurrences: bodyGroup.map(({ canonicalBody: _, ...occurrence }) => occurrence),
      });
    }
  }

  const byBody = new Map<string, InternalRuleOccurrence[]>();
  for (const occurrence of occurrences) {
    if (occurrence.legacy_id === null) continue;
    const matching = byBody.get(occurrence.canonicalBody) ?? [];
    matching.push(occurrence);
    byBody.set(occurrence.canonicalBody, matching);
  }
  const candidates = [...byBody.values()]
    .map((matching): RuleMergeCandidate | null => {
      const legacyIds = [...new Set(matching.flatMap((item) => item.legacy_id ?? []))].sort();
      return legacyIds.length > 1
        ? {
            content_sha256: matching[0]?.content_sha256 ?? sha256({}),
            legacy_ids: legacyIds,
            occurrence_count: matching.length,
          }
        : null;
    })
    .filter((candidate): candidate is RuleMergeCandidate => candidate !== null)
    .sort((left, right) => textOrder(left.content_sha256, right.content_sha256));

  return { occurrences, groups, candidates, nextSequence: sequence };
};

const buildRuleApplications = (
  inventory: RuleInventory,
  localMappings: readonly LocalIdMapping[],
): readonly RuleApplicationMapping[] => {
  const groupByOccurrence = new Map<string, RuleGroup>();
  for (const group of inventory.groups) {
    for (const occurrence of group.occurrences) {
      groupByOccurrence.set(`${occurrence.owner_id}\u0000${occurrence.path}`, group);
    }
  }
  const applicationIdByOccurrence = new Map(
    localMappings
      .filter((mapping) => mapping.namespace === "rule_applications")
      .map(
        (mapping) => [`${mapping.entity_id}\u0000${mapping.source_path}`, mapping.v2_id] as const,
      ),
  );
  return inventory.occurrences.map((occurrence) => ({
    owner_type: occurrence.owner_type,
    owner_id: occurrence.owner_id,
    owner_key: occurrence.owner_key,
    source_path: occurrence.path,
    application_id:
      applicationIdByOccurrence.get(`${occurrence.owner_id}\u0000${occurrence.path}`) ?? null,
    legacy_rule_id: occurrence.legacy_id,
    rule_key:
      groupByOccurrence.get(`${occurrence.owner_id}\u0000${occurrence.path}`)?.proposed_rule_key ??
      null,
  }));
};

const IMPLEMENTS_NAMESPACE = {
  requirement_ids: "requirements",
  acceptance_criteria_ids: "acceptance_criteria",
  behavior_case_ids: "behavior_cases",
  change_ids: "changes",
  hypothesis_ids: "hypotheses",
  research_question_ids: "research_questions",
  success_criteria_ids: "success_criteria",
  decision_rule_ids: "decision_rules",
  investigation_question_ids: "investigation_questions",
  refactor_target_ids: "refactor_targets",
  invariant_ids: "invariants",
  quality_goal_ids: "quality_goals",
  maintenance_goal_ids: "maintenance_goals",
} as const;

const localResolution = (
  mappings: readonly LocalIdMapping[],
  ownerId: string,
  namespace: string,
  legacyId: string,
): readonly string[] => [
  ...new Set(
    mappings
      .filter(
        (mapping) =>
          mapping.entity_id === ownerId &&
          mapping.namespace === namespace &&
          mapping.legacy_id === legacyId &&
          mapping.v2_id !== null,
      )
      .map((mapping) => mapping.v2_id as string),
  ),
];

const pushReference = (
  references: StructuredReference[],
  conflicts: MigrationFinding[],
  owner: CurrentEntitySnapshot & { readonly entity_type: HierarchyEntityType },
  input: Omit<StructuredReference, "owner_id" | "owner_key" | "owner_type">,
): void => {
  references.push({
    owner_type: owner.entity_type,
    owner_id: owner.id,
    owner_key: owner.key,
    ...input,
  });
  if (input.resolution === "resolved" || input.resolution === "unchanged") return;
  conflicts.push(
    finding(
      input.resolution === "ambiguous"
        ? "ambiguous_structured_reference"
        : "unresolved_structured_reference",
      owner.project_id,
      `${input.legacy_value} cannot be ${input.resolution === "ambiguous" ? "uniquely" : ""} resolved for ${input.kind}.`,
      {
        entity_type: owner.entity_type,
        entity_id: owner.id,
        entity_key: owner.key,
        path: input.path,
      },
    ),
  );
};

const ruleResolution = (
  value: string,
  inventory: RuleInventory,
  existingRuleKeys: ReadonlySet<string>,
): readonly string[] => {
  if (existingRuleKeys.has(value)) return [value];
  return [
    ...new Set(
      inventory.groups
        .filter((group) => group.legacy_id === value && group.proposed_rule_key !== null)
        .map((group) => group.proposed_rule_key as string),
    ),
  ];
};

const collectStructuredReferences = (
  entities: readonly (CurrentEntitySnapshot & { readonly entity_type: HierarchyEntityType })[],
  localMappings: readonly LocalIdMapping[],
  inventory: RuleInventory,
  allProjectEntities: readonly CurrentEntitySnapshot[],
  conflicts: MigrationFinding[],
): readonly StructuredReference[] => {
  const references: StructuredReference[] = [];
  const entityById = new Map(allProjectEntities.map((entity) => [entity.id, entity]));
  const streamById = new Map(
    entities
      .filter((entity) => entity.entity_type === "stream")
      .map((entity) => [entity.id, entity]),
  );
  const existingRuleKeys = new Set(
    allProjectEntities
      .filter((entity) => entity.entity_type === "rule")
      .map((entity) => entity.key),
  );

  for (const owner of entities) {
    const document = owner.document;
    const links = recordOf(document.links);
    const expectedParentField =
      owner.entity_type === "stream"
        ? "parent_epic_id"
        : owner.entity_type === "task"
          ? "parent_stream_id"
          : null;
    if (expectedParentField !== null) {
      const parentValue = links[expectedParentField];
      if (typeof parentValue === "string") {
        pushReference(references, conflicts, owner, {
          path: `links.${expectedParentField}`,
          kind: expectedParentField,
          legacy_value: parentValue,
          v2_value: parentValue,
          resolution: parentValue === owner.parent_id ? "unchanged" : "unresolved",
        });
      }
    }

    const provenance = recordOf(document.provenance);
    arrayOf(provenance.created_from).forEach((value, index) => {
      if (typeof value !== "string") return;
      const target = entityById.get(value);
      pushReference(references, conflicts, owner, {
        path: `provenance.created_from[${String(index)}]`,
        kind: "created_from",
        legacy_value: value,
        v2_value: value,
        // A source entity may have been deleted while its derivation remains useful.
        resolution: target ? "unchanged" : "unchanged",
      });
    });

    for (const [linkField, value] of Object.entries(links)) {
      if (linkField === "parent_epic_id" || linkField === "parent_stream_id") continue;
      arrayOf(value).forEach((entry, index) => {
        const targetId = recordOf(entry).target_id;
        if (typeof targetId !== "string") return;
        pushReference(references, conflicts, owner, {
          path: `links.${linkField}[${String(index)}].target_id`,
          kind: `document_link:${linkField}`,
          legacy_value: targetId,
          v2_value: targetId,
          resolution: entityById.has(targetId) ? "unchanged" : "unresolved",
        });
      });
    }

    if (owner.entity_type !== "task") {
      arrayOf(atPath(document, ["content", "rule_applications"])).forEach((application, index) => {
        const ruleKey = recordOf(application).rule_key;
        if (typeof ruleKey !== "string") return;
        const resolved = ruleResolution(ruleKey, inventory, existingRuleKeys);
        pushReference(references, conflicts, owner, {
          path: `content.rule_applications[${String(index)}].rule_key`,
          kind: "rule_application",
          legacy_value: ruleKey,
          v2_value: resolved.length === 1 ? (resolved[0] ?? null) : null,
          resolution:
            resolved.length === 1
              ? resolved[0] === ruleKey
                ? "unchanged"
                : "resolved"
              : resolved.length > 1
                ? "ambiguous"
                : "unresolved",
        });
      });
    }

    if (owner.entity_type === "stream") {
      const criteria = arrayOf(atPath(document, ["content", "acceptance_criteria"]));
      criteria.forEach((criterion, criterionIndex) => {
        const verifies = recordOf(criterion).verifies;
        const resolveRequirement = (legacyId: string, path: string): void => {
          const local = localResolution(localMappings, owner.id, "requirements", legacyId);
          const rules = ruleResolution(legacyId, inventory, existingRuleKeys);
          const combined = [...local, ...rules];
          pushReference(references, conflicts, owner, {
            path,
            kind:
              local.length > 0 && rules.length === 0
                ? "acceptance_criterion_requirement"
                : rules.length > 0 && local.length === 0
                  ? "acceptance_criterion_rule"
                  : "acceptance_criterion_verifies",
            legacy_value: legacyId,
            v2_value: combined.length === 1 ? (combined[0] ?? null) : null,
            resolution:
              combined.length === 1 ? "resolved" : combined.length > 1 ? "ambiguous" : "unresolved",
          });
        };
        if (Array.isArray(verifies)) {
          verifies.forEach((value, verifiesIndex) => {
            if (typeof value === "string") {
              resolveRequirement(
                value,
                `content.acceptance_criteria[${String(criterionIndex)}].verifies[${String(verifiesIndex)}]`,
              );
            }
          });
        } else {
          const typed = recordOf(verifies);
          arrayOf(typed.requirement_ids).forEach((value, referenceIndex) => {
            if (typeof value === "string") {
              const resolved = localResolution(localMappings, owner.id, "requirements", value);
              pushReference(references, conflicts, owner, {
                path: `content.acceptance_criteria[${String(criterionIndex)}].verifies.requirement_ids[${String(referenceIndex)}]`,
                kind: "acceptance_criterion_requirement",
                legacy_value: value,
                v2_value: resolved.length === 1 ? (resolved[0] ?? null) : null,
                resolution:
                  resolved.length === 1
                    ? "resolved"
                    : resolved.length > 1
                      ? "ambiguous"
                      : "unresolved",
              });
            }
          });
          arrayOf(typed.rule_keys).forEach((value, referenceIndex) => {
            if (typeof value === "string") {
              const resolved = ruleResolution(value, inventory, existingRuleKeys);
              pushReference(references, conflicts, owner, {
                path: `content.acceptance_criteria[${String(criterionIndex)}].verifies.rule_keys[${String(referenceIndex)}]`,
                kind: "acceptance_criterion_rule",
                legacy_value: value,
                v2_value: resolved.length === 1 ? (resolved[0] ?? null) : null,
                resolution:
                  resolved.length === 1
                    ? resolved[0] === value
                      ? "unchanged"
                      : "resolved"
                    : resolved.length > 1
                      ? "ambiguous"
                      : "unresolved",
              });
            }
          });
        }
      });
      continue;
    }

    if (owner.entity_type !== "task") continue;
    const implementation = recordOf(atPath(document, ["content", "implements"]));
    const streamId = implementation.stream_id;
    const parentStream = owner.parent_id ? streamById.get(owner.parent_id) : undefined;
    if (typeof streamId === "string") {
      pushReference(references, conflicts, owner, {
        path: "content.implements.stream_id",
        kind: "parent_stream",
        legacy_value: streamId,
        v2_value: streamId,
        resolution: streamId === owner.parent_id ? "unchanged" : "unresolved",
      });
    }
    for (const [field, namespace] of Object.entries(IMPLEMENTS_NAMESPACE)) {
      arrayOf(implementation[field]).forEach((value, index) => {
        if (typeof value !== "string") return;
        const resolved = parentStream
          ? localResolution(localMappings, parentStream.id, namespace, value)
          : [];
        pushReference(references, conflicts, owner, {
          path: `content.implements.${field}[${String(index)}]`,
          kind: `task_${namespace}`,
          legacy_value: value,
          v2_value: resolved.length === 1 ? (resolved[0] ?? null) : null,
          resolution:
            resolved.length === 1 ? "resolved" : resolved.length > 1 ? "ambiguous" : "unresolved",
        });
      });
    }
    arrayOf(atPath(document, ["content", "constrained_by_rule_keys"])).forEach((value, index) => {
      if (typeof value !== "string") return;
      const resolved = ruleResolution(value, inventory, existingRuleKeys);
      pushReference(references, conflicts, owner, {
        path: `content.constrained_by_rule_keys[${String(index)}]`,
        kind: "task_rule_constraint",
        legacy_value: value,
        v2_value: resolved.length === 1 ? (resolved[0] ?? null) : null,
        resolution:
          resolved.length === 1
            ? resolved[0] === value
              ? "unchanged"
              : "resolved"
            : resolved.length > 1
              ? "ambiguous"
              : "unresolved",
      });
    });
  }
  return references.sort(
    (left, right) =>
      (ENTITY_ORDER[left.owner_type] ?? 99) - (ENTITY_ORDER[right.owner_type] ?? 99) ||
      numberedTextOrder(left.owner_key, right.owner_key) ||
      textOrder(left.path, right.path) ||
      textOrder(left.legacy_value, right.legacy_value),
  );
};

const STRUCTURED_STRING_FIELD = new Set([
  "entity",
  "schema_version",
  "id",
  "key",
  "status",
  "stream_type",
  "task_type",
  "type",
  "rule_key",
  "stream_key",
  "created_from",
  "verifies",
]);

const REFERENCE_TOKEN = /\b(?:[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-[0-9]+)\b/g;

const collectProseMentions = (
  entities: readonly (CurrentEntitySnapshot & { readonly entity_type: HierarchyEntityType })[],
  keys: readonly EntityKeyMapping[],
  locals: readonly LocalIdMapping[],
  rules: RuleInventory,
): readonly ProseMention[] => {
  const mentions: ProseMention[] = [];
  for (const owner of entities) {
    const keyMap = new Map(keys.map((mapping) => [mapping.legacy_key, mapping.v2_key] as const));
    const localMap = new Map<string, string[]>();
    for (const mapping of locals.filter((item) => item.entity_id === owner.id)) {
      if (mapping.legacy_id === null || mapping.v2_id === null) continue;
      const mapped = localMap.get(mapping.legacy_id) ?? [];
      mapped.push(mapping.v2_id);
      localMap.set(mapping.legacy_id, mapped);
    }
    const ruleMap = new Map<string, string[]>();
    for (const group of rules.groups) {
      if (group.proposed_rule_key === null) continue;
      const mapped = ruleMap.get(group.legacy_id) ?? [];
      mapped.push(group.proposed_rule_key);
      ruleMap.set(group.legacy_id, mapped);
    }

    const visit = (value: unknown, path: string, field: string | null): void => {
      if (typeof value === "string") {
        if (
          field !== null &&
          (STRUCTURED_STRING_FIELD.has(field) || field.endsWith("_id") || field.endsWith("_ids"))
        ) {
          return;
        }
        const tokens = [...new Set(value.match(REFERENCE_TOKEN) ?? [])].sort();
        for (const token of tokens) {
          const entityTarget = keyMap.get(token);
          const localTargets = localMap.get(token) ?? [];
          const ruleTargets = ruleMap.get(token) ?? [];
          mentions.push({
            owner_type: owner.entity_type,
            owner_id: owner.id,
            owner_key: owner.key,
            path,
            token,
            classification:
              entityTarget !== undefined
                ? "entity_key"
                : localTargets.length > 0
                  ? "local_id"
                  : ruleTargets.length > 0
                    ? "rule_id"
                    : "unknown",
            mapped_to:
              entityTarget !== undefined
                ? entityTarget === null
                  ? []
                  : [entityTarget]
                : [...new Set([...localTargets, ...ruleTargets])].sort(),
          });
        }
        return;
      }
      if (Array.isArray(value)) {
        value.forEach((child, index) => visit(child, `${path}[${String(index)}]`, field));
        return;
      }
      if (typeof value !== "object" || value === null) return;
      for (const [key, child] of Object.entries(value)) {
        visit(child, path === "" ? key : `${path}.${key}`, key);
      }
    };
    visit(owner.document, "", null);
  }
  return mentions.sort(
    (left, right) =>
      (ENTITY_ORDER[left.owner_type] ?? 99) - (ENTITY_ORDER[right.owner_type] ?? 99) ||
      numberedTextOrder(left.owner_key, right.owner_key) ||
      textOrder(left.path, right.path) ||
      textOrder(left.token, right.token),
  );
};

const currentRowHash = (row: CurrentEntitySnapshot): RowHash => {
  const documentHash = sha256(row.document);
  return {
    identity: `${row.entity_type}:${row.id}:r${String(row.revision)}`,
    document_sha256: documentHash,
    row_sha256: sha256({
      entity_type: row.entity_type,
      id: row.id,
      workspace_id: row.workspace_id,
      project_id: row.project_id,
      parent_id: row.parent_id,
      key: row.key,
      status: row.status,
      subtype: row.subtype,
      revision: row.revision,
      title: row.title,
      summary: row.summary,
      document_sha256: documentHash,
      created_at: row.created_at,
      updated_at: row.updated_at,
    }),
  };
};

const revisionRowHash = (row: RevisionSnapshot): RowHash => {
  const documentHash = sha256(row.document);
  return {
    identity: `${row.entity_type}:${row.entity_id}:r${String(row.revision)}`,
    document_sha256: documentHash,
    row_sha256: sha256({
      entity_type: row.entity_type,
      entity_id: row.entity_id,
      revision: row.revision,
      workspace_id: row.workspace_id,
      project_id: row.project_id,
      document_sha256: documentHash,
      changed_by: row.changed_by,
      change_reason: row.change_reason,
      created_at: row.created_at,
    }),
  };
};

const linkRowHash = (row: LinkSnapshot): RowHash => ({
  identity: row.id,
  row_sha256: sha256(row),
});

const auditCurrentDocuments = (
  project: ProjectSnapshot,
  entities: readonly CurrentEntitySnapshot[],
  revisions: readonly RevisionSnapshot[],
  conflicts: MigrationFinding[],
  warnings: MigrationFinding[],
): void => {
  const expectedSchema = {
    epic: "pm.epic.v1",
    stream: "pm.stream.v1",
    task: "pm.task.v1",
  } as const;
  const revisionsByEntity = new Map<string, RevisionSnapshot[]>();
  for (const revision of revisions) {
    const key = `${revision.entity_type}\u0000${revision.entity_id}`;
    const matching = revisionsByEntity.get(key) ?? [];
    matching.push(revision);
    revisionsByEntity.set(key, matching);
  }

  for (const entity of entities) {
    if (!hierarchyEntity(entity)) continue;
    const document = entity.document;
    const meta = recordOf(document.meta);
    const schemaVersion = document.schema_version;
    const context = {
      entity_type: entity.entity_type,
      entity_id: entity.id,
      entity_key: entity.key,
    } as const;
    if (schemaVersion !== expectedSchema[entity.entity_type]) {
      conflicts.push(
        finding(
          "unexpected_current_schema_version",
          project.id,
          `Expected ${expectedSchema[entity.entity_type]} before cutover, received ${String(schemaVersion)}.`,
          { ...context, path: "schema_version" },
        ),
      );
    }
    if (document.entity !== entity.entity_type) {
      conflicts.push(
        finding("document_entity_mismatch", project.id, "Document entity differs from its table.", {
          ...context,
          path: "entity",
          details: { document: String(document.entity), row: entity.entity_type },
        }),
      );
    }
    for (const [field, expected] of [
      ["id", entity.id],
      ["key", entity.key],
      ["project_id", entity.project_id],
      ["workspace_id", entity.workspace_id],
      ["revision", entity.revision],
      ["status", entity.status],
    ] as const) {
      if (meta[field] !== expected) {
        conflicts.push(
          finding(
            "row_document_projection_mismatch",
            project.id,
            `meta.${field} differs from the relational row.`,
            {
              ...context,
              path: `meta.${field}`,
              details: {
                document: canonicalValue(meta[field]),
                row: canonicalValue(expected),
              },
            },
          ),
        );
      }
    }

    const history = (revisionsByEntity.get(`${entity.entity_type}\u0000${entity.id}`) ?? []).sort(
      (left, right) => left.revision - right.revision,
    );
    const expectedRevisions = Array.from({ length: entity.revision }, (_, index) => index + 1);
    if (
      canonicalJson(history.map((revision) => revision.revision)) !==
      canonicalJson(expectedRevisions)
    ) {
      conflicts.push(
        finding(
          "revision_history_gap",
          project.id,
          `Revision history is not the contiguous range 1..${String(entity.revision)}.`,
          {
            ...context,
            details: history.map((revision) => revision.revision),
          },
        ),
      );
    }
    const currentRevision = history.find((revision) => revision.revision === entity.revision);
    const withoutProjectProjection = (document: Record<string, unknown>): JsonValue => {
      const root = recordOf(canonicalValue(document));
      const meta = recordOf(root.meta);
      return canonicalValue({ ...root, meta: { ...meta, project_id: "<project-projection>" } });
    };
    if (!currentRevision) {
      conflicts.push(
        finding(
          "current_revision_snapshot_mismatch",
          project.id,
          "The current row has no history snapshot at its revision.",
          context,
        ),
      );
    } else if (sha256(currentRevision.document) !== sha256(entity.document)) {
      if (
        sha256(withoutProjectProjection(currentRevision.document)) ===
        sha256(withoutProjectProjection(entity.document))
      ) {
        warnings.push(
          finding(
            "current_project_projection_differs_from_history",
            project.id,
            "Current JSON differs from its same-numbered history snapshot only in meta.project_id, consistent with an ancestor move.",
            context,
          ),
        );
      } else {
        conflicts.push(
          finding(
            "current_revision_snapshot_mismatch",
            project.id,
            "The current row document does not match the history snapshot at its revision.",
            context,
          ),
        );
      }
    }
    for (const revision of history) {
      if (revision.workspace_id !== entity.workspace_id) {
        conflicts.push(
          finding(
            "revision_scope_mismatch",
            project.id,
            `Revision ${String(revision.revision)} is recorded under a different workspace.`,
            { ...context, path: `revision.${String(revision.revision)}` },
          ),
        );
      } else if (revision.project_id !== entity.project_id) {
        warnings.push(
          finding(
            "historical_revision_project_differs",
            project.id,
            `Revision ${String(revision.revision)} predates a cross-Project move and remains scoped to its original Project.`,
            { ...context, path: `revision.${String(revision.revision)}` },
          ),
        );
      }
    }
  }
};

const auditHierarchy = (
  project: ProjectSnapshot,
  entities: readonly CurrentEntitySnapshot[],
  conflicts: MigrationFinding[],
): void => {
  const byId = new Map(entities.map((entity) => [entity.id, entity]));
  for (const entity of entities) {
    if (!hierarchyEntity(entity)) continue;
    if (entity.workspace_id !== project.workspace_id) {
      conflicts.push(
        finding(
          "entity_workspace_mismatch",
          project.id,
          "Entity workspace differs from its Project workspace.",
          {
            entity_type: entity.entity_type,
            entity_id: entity.id,
            entity_key: entity.key,
          },
        ),
      );
    }
    if (entity.entity_type === "epic") continue;
    const parent = entity.parent_id ? byId.get(entity.parent_id) : undefined;
    const expectedType = entity.entity_type === "stream" ? "epic" : "stream";
    if (!parent || parent.entity_type !== expectedType || parent.project_id !== project.id) {
      conflicts.push(
        finding(
          "invalid_hierarchy_parent",
          project.id,
          `${entity.entity_type} parent does not resolve to a ${expectedType} in the same Project.`,
          {
            entity_type: entity.entity_type,
            entity_id: entity.id,
            entity_key: entity.key,
            path: "parent_id",
            details: { parent_id: entity.parent_id },
          },
        ),
      );
    }
  }
};

const auditLinks = (
  project: ProjectSnapshot,
  entities: readonly CurrentEntitySnapshot[],
  links: readonly LinkSnapshot[],
  conflicts: MigrationFinding[],
): void => {
  const byEndpoint = new Map(
    entities.map((entity) => [`${entity.entity_type}\u0000${entity.id}`, entity]),
  );
  for (const link of links) {
    const source = byEndpoint.get(`${link.source_type}\u0000${link.source_id}`);
    const target = byEndpoint.get(`${link.target_type}\u0000${link.target_id}`);
    if (!source || !target) {
      conflicts.push(
        finding("dangling_entity_link", project.id, "A relational link endpoint does not exist.", {
          path: `entity_link.${link.id}`,
          details: {
            source: `${link.source_type}:${link.source_id}`,
            source_exists: Boolean(source),
            target: `${link.target_type}:${link.target_id}`,
            target_exists: Boolean(target),
          },
        }),
      );
      continue;
    }
    if (link.workspace_id !== project.workspace_id) {
      conflicts.push(
        finding(
          "link_project_workspace_mismatch",
          project.id,
          "Link and Project workspace differ.",
          { path: `entity_link.${link.id}` },
        ),
      );
    }
    if (
      (link.source_type !== "epic" &&
        link.source_type !== "stream" &&
        link.source_type !== "task") ||
      (link.target_type !== "epic" && link.target_type !== "stream" && link.target_type !== "task")
    ) {
      conflicts.push(
        finding(
          "invalid_entity_link_endpoint_type",
          project.id,
          "Rule and Milestone are not entity_link endpoints.",
          { path: `entity_link.${link.id}` },
        ),
      );
    }
    if (
      source.project_id !== project.id ||
      target.project_id !== project.id ||
      source.workspace_id !== project.workspace_id ||
      target.workspace_id !== project.workspace_id
    ) {
      conflicts.push(
        finding(
          "cross_scope_entity_link",
          project.id,
          "A relational link crosses Project or Workspace scope.",
          {
            path: `entity_link.${link.id}`,
          },
        ),
      );
    }
    if (
      link.relationship_type === "blocked_by" &&
      (link.source_type !== link.target_type ||
        (link.source_type !== "stream" && link.source_type !== "task"))
    ) {
      conflicts.push(
        finding(
          "invalid_blocked_by_endpoints",
          project.id,
          "blocked_by must connect Task to Task or Stream to Stream.",
          { path: `entity_link.${link.id}` },
        ),
      );
    }
  }
};

const auditLegacyShapes = (
  entities: readonly (CurrentEntitySnapshot & { readonly entity_type: HierarchyEntityType })[],
  conflicts: MigrationFinding[],
  warnings: MigrationFinding[],
): void => {
  const readyStreamStatus = new Set(["ready", "in_progress", "blocked", "completed"]);
  for (const entity of entities) {
    const provenance = recordOf(entity.document.provenance);
    arrayOf(provenance.sources).forEach((value, index) => {
      const source = recordOf(value);
      if (typeof source.reference !== "string" || source.reference.trim() === "") {
        conflicts.push(
          finding(
            "source_reference_missing",
            entity.project_id,
            "A legacy Source has no immutable reference required by v2.",
            {
              entity_type: entity.entity_type,
              entity_id: entity.id,
              entity_key: entity.key,
              path: `provenance.sources[${String(index)}].reference`,
            },
          ),
        );
      }
      if (source.type === "inference") {
        conflicts.push(
          finding(
            "inference_is_not_a_source",
            entity.project_id,
            "Legacy Source type inference needs an explicit claim-level evidence mapping.",
            {
              entity_type: entity.entity_type,
              entity_id: entity.id,
              entity_key: entity.key,
              path: `provenance.sources[${String(index)}].type`,
            },
          ),
        );
      }
      if (source.confidence !== undefined) {
        warnings.push(
          finding(
            "legacy_source_confidence_removed",
            entity.project_id,
            "Source confidence is not copied; v2 basis belongs on individual claims.",
            {
              entity_type: entity.entity_type,
              entity_id: entity.id,
              entity_key: entity.key,
              path: `provenance.sources[${String(index)}].confidence`,
            },
          ),
        );
      }
    });
    arrayOf(provenance.inferred_fields).forEach((value, index) => {
      conflicts.push(
        finding(
          "inferred_field_needs_claim_mapping",
          entity.project_id,
          `Legacy inferred field ${String(value)} is path-based and needs a claim-level Evidence target.`,
          {
            entity_type: entity.entity_type,
            entity_id: entity.id,
            entity_key: entity.key,
            path: `provenance.inferred_fields[${String(index)}]`,
          },
        ),
      );
    });

    if (entity.entity_type !== "stream") continue;
    const content = recordOf(entity.document.content);
    if (entity.subtype === "bug") {
      const behaviorCases = arrayOf(content.behavior_cases);
      const actual = content.actual_behavior;
      const expected = content.expected_behavior;
      const legacyFields = [content.reproduction, actual, expected, content.severity];
      const hasLegacyBehavior = legacyFields.some((value) => value !== undefined);
      if (behaviorCases.length > 0 && hasLegacyBehavior) {
        conflicts.push(
          finding(
            "mixed_bug_behavior_storage",
            entity.project_id,
            "The bug contains both legacy scalar behavior and v2 behavior_cases.",
            {
              entity_type: entity.entity_type,
              entity_id: entity.id,
              entity_key: entity.key,
              path: "content",
            },
          ),
        );
      }
      if (hasLegacyBehavior && (actual === undefined || expected === undefined)) {
        conflicts.push(
          finding(
            "partial_legacy_bug_behavior",
            entity.project_id,
            "A v2 BC item cannot preserve only one of actual_behavior and expected_behavior.",
            {
              entity_type: entity.entity_type,
              entity_id: entity.id,
              entity_key: entity.key,
              path: "content",
            },
          ),
        );
      }
    }
    if (
      readyStreamStatus.has(entity.status) &&
      entity.subtype === "investigation" &&
      (arrayOf(content.questions).length === 0 ||
        (arrayOf(content.success_criteria).length === 0 &&
          (typeof content.expected_decision !== "string" ||
            content.expected_decision.trim() === "")))
    ) {
      conflicts.push(
        finding(
          "ready_investigation_missing_v2_targets",
          entity.project_id,
          "Investigation is ready-or-later but lacks questions or a finish decision/criterion.",
          {
            entity_type: entity.entity_type,
            entity_id: entity.id,
            entity_key: entity.key,
            path: "content",
          },
        ),
      );
    }
    if (
      readyStreamStatus.has(entity.status) &&
      ((entity.subtype === "change" && arrayOf(content.changes).length === 0) ||
        (entity.subtype === "experiment" &&
          (arrayOf(content.hypotheses).length === 0 ||
            arrayOf(content.success_criteria).length === 0 ||
            arrayOf(content.decision_rules).length === 0)) ||
        (entity.subtype === "refactor" &&
          (arrayOf(content.refactor_targets).length === 0 ||
            arrayOf(content.invariants).length === 0)) ||
        (entity.subtype === "maintenance" && arrayOf(content.maintenance_goals).length === 0))
    ) {
      conflicts.push(
        finding(
          "ready_stream_missing_v2_targets",
          entity.project_id,
          `${entity.subtype ?? "unknown"} Stream is ready-or-later but lacks its mandatory v2 targets.`,
          {
            entity_type: entity.entity_type,
            entity_id: entity.id,
            entity_key: entity.key,
            path: "content",
          },
        ),
      );
    }
  }
};

const keyMappingsForProject = (
  project: ProjectSnapshot,
  hierarchy: readonly (CurrentEntitySnapshot & { readonly entity_type: HierarchyEntityType })[],
  conflicts: MigrationFinding[],
): readonly EntityKeyMapping[] => {
  const mappings = hierarchy.map((entity): EntityKeyMapping => {
    const definition = ENTITY_KEY_PREFIX[entity.entity_type];
    const sequence = parseNumberedKey(entity.key, definition.legacy);
    if (sequence === null) {
      conflicts.push(
        finding(
          "invalid_legacy_entity_key",
          project.id,
          `${entity.key} is not a generated legacy or v2 ${entity.entity_type} key.`,
          {
            entity_type: entity.entity_type,
            entity_id: entity.id,
            entity_key: entity.key,
            path: "key",
          },
        ),
      );
    }
    return {
      entity_type: entity.entity_type,
      entity_id: entity.id,
      legacy_key: entity.key,
      v2_key: sequence === null ? null : `${definition.v2}-${String(sequence)}`,
      sequence,
    };
  });

  const byTarget = new Map<string, EntityKeyMapping[]>();
  for (const mapping of mappings) {
    if (mapping.v2_key === null) continue;
    const key = `${mapping.entity_type}\u0000${mapping.v2_key}`;
    const matching = byTarget.get(key) ?? [];
    matching.push(mapping);
    byTarget.set(key, matching);
  }
  for (const matching of byTarget.values()) {
    if (matching.length < 2) continue;
    const first = matching[0];
    if (!first) continue;
    conflicts.push(
      finding(
        "v2_entity_key_collision",
        project.id,
        `${String(matching.length)} rows map to ${first.v2_key ?? "an unknown key"}.`,
        {
          entity_type: first.entity_type,
          path: "key",
          details: matching.map((mapping) => ({
            entity_id: mapping.entity_id,
            legacy_key: mapping.legacy_key,
          })),
        },
      ),
    );
  }
  return mappings.sort(
    (left, right) =>
      (ENTITY_ORDER[left.entity_type] ?? 99) - (ENTITY_ORDER[right.entity_type] ?? 99) ||
      (left.sequence ?? Number.MAX_SAFE_INTEGER) - (right.sequence ?? Number.MAX_SAFE_INTEGER) ||
      textOrder(left.entity_id, right.entity_id),
  );
};

const observedSequence = (entities: readonly CurrentEntitySnapshot[], entityType: string): number =>
  Math.max(
    0,
    ...entities
      .filter((entity) => entity.entity_type === entityType)
      .map((entity) => {
        const prefixes =
          entityType === "epic"
            ? ["EPIC", "E"]
            : entityType === "stream"
              ? ["STR", "S"]
              : entityType === "task"
                ? ["TASK", "T"]
                : entityType === "milestone"
                  ? ["M"]
                  : ["R"];
        return parseNumberedKey(entity.key, prefixes) ?? 0;
      }),
  );

const buildProjectReport = (
  snapshot: DatabaseSnapshot,
  project: ProjectSnapshot,
): ProjectPreflightReport => {
  const conflicts: MigrationFinding[] = [];
  const warnings: MigrationFinding[] = [];
  const entities = snapshot.entities
    .filter((entity) => entity.project_id === project.id)
    .sort(entityOrder);
  const hierarchy = entities.filter(hierarchyEntity);
  const revisions = snapshot.revisions.filter((revision) => revision.project_id === project.id);
  const links = snapshot.links.filter((link) => link.project_id === project.id);

  auditHierarchy(project, entities, conflicts);
  auditCurrentDocuments(project, entities, snapshot.revisions, conflicts, warnings);
  auditLinks(project, entities, links, conflicts);
  auditLegacyShapes(hierarchy, conflicts, warnings);

  const keyMappings = keyMappingsForProject(project, hierarchy, conflicts);
  const candidates = collectLocalCandidates(hierarchy);
  const localMappings = allocateLocalIds(candidates, conflicts, warnings);
  const ruleInventory = buildRuleInventory(project, entities, hierarchy, conflicts);
  const applications = buildRuleApplications(ruleInventory, localMappings);
  const structuredReferences = collectStructuredReferences(
    hierarchy,
    localMappings,
    ruleInventory,
    entities,
    conflicts,
  );
  const proseMentions = collectProseMentions(hierarchy, keyMappings, localMappings, ruleInventory);

  const currentRows = entities.map(currentRowHash);
  const revisionRows = revisions.map(revisionRowHash);
  const linkRows = links.map(linkRowHash);

  const observedMax = {
    epic: observedSequence(entities, "epic"),
    stream: observedSequence(entities, "stream"),
    task: observedSequence(entities, "task"),
    milestone: observedSequence(entities, "milestone"),
    rule: observedSequence(entities, "rule"),
  };
  for (const entity of entities.filter(
    (candidate) => candidate.entity_type === "rule" || candidate.entity_type === "milestone",
  )) {
    const expectedPrefix = entity.entity_type === "rule" ? "R" : "M";
    if (parseNumberedKey(entity.key, [expectedPrefix]) === null) {
      conflicts.push(
        finding(
          "invalid_v2_entity_key",
          project.id,
          `${entity.key} is not a canonical ${entity.entity_type} key.`,
          {
            entity_type: entity.entity_type,
            entity_id: entity.id,
            entity_key: entity.key,
            path: "key",
          },
        ),
      );
    }
  }
  const stored = {
    epic: project.epic_counter,
    stream: project.stream_counter,
    task: project.task_counter,
    milestone: project.milestone_counter,
    rule: project.rule_counter,
  };
  for (const entityType of ["epic", "stream", "task"] as const) {
    if (stored[entityType] < observedMax[entityType]) {
      conflicts.push(
        finding(
          "counter_below_observed_key",
          project.id,
          `${entityType}_counter ${String(stored[entityType])} is below observed key sequence ${String(observedMax[entityType])}.`,
          { path: `project.${entityType}_counter` },
        ),
      );
    }
  }
  if (stored.rule !== null && stored.rule < observedMax.rule) {
    conflicts.push(
      finding(
        "counter_below_observed_key",
        project.id,
        `rule_counter ${String(stored.rule)} is below observed key sequence ${String(observedMax.rule)}.`,
        { path: "project.rule_counter" },
      ),
    );
  }
  if (stored.milestone !== null && stored.milestone < observedMax.milestone) {
    conflicts.push(
      finding(
        "counter_below_observed_key",
        project.id,
        `milestone_counter ${String(stored.milestone)} is below observed key sequence ${String(observedMax.milestone)}.`,
        { path: "project.milestone_counter" },
      ),
    );
  }

  const currentCounts = {
    epic: entities.filter((entity) => entity.entity_type === "epic").length,
    stream: entities.filter((entity) => entity.entity_type === "stream").length,
    task: entities.filter((entity) => entity.entity_type === "task").length,
    milestone: entities.filter((entity) => entity.entity_type === "milestone").length,
    rule: entities.filter((entity) => entity.entity_type === "rule").length,
  };
  const requiredAfterCutover = {
    epic: Math.max(stored.epic, observedMax.epic),
    stream: Math.max(stored.stream, observedMax.stream),
    task: Math.max(stored.task, observedMax.task),
    milestone: Math.max(stored.milestone ?? 0, observedMax.milestone),
    rule: Math.max(stored.rule ?? 0, observedMax.rule, ruleInventory.nextSequence),
  };

  return {
    workspace_id: project.workspace_id,
    project_id: project.id,
    project_name: project.name,
    counters: { stored, observed_max: observedMax, required_after_cutover: requiredAfterCutover },
    counts: {
      current: currentCounts,
      revisions: countsBy(revisions.map((revision) => revision.entity_type)),
      links: links.length,
    },
    key_mappings: keyMappings,
    local_id_mappings: localMappings,
    rules: {
      occurrences: ruleInventory.occurrences.map(
        ({ canonicalBody: _, ...occurrence }) => occurrence,
      ),
      groups: ruleInventory.groups,
      same_content_different_id_candidates: ruleInventory.candidates,
      applications,
    },
    structured_references: structuredReferences,
    prose_mentions: proseMentions,
    audit: {
      project_row_sha256: sha256(project),
      current_rows: currentRows,
      current_rows_sha256: sha256(currentRows),
      revision_rows: revisionRows,
      revision_rows_sha256: sha256(revisionRows),
      link_rows: linkRows,
      link_rows_sha256: sha256(linkRows),
    },
    conflicts: conflicts.sort(findingOrder),
    warnings: warnings.sort(findingOrder),
  };
};

const globalFindings = (
  snapshot: DatabaseSnapshot,
): {
  readonly conflicts: readonly MigrationFinding[];
  readonly warnings: readonly MigrationFinding[];
} => {
  const conflicts: MigrationFinding[] = [];
  const warnings: MigrationFinding[] = [];
  const projects = new Map(snapshot.projects.map((project) => [project.id, project]));
  const currentEntity = new Set(
    snapshot.entities.map((entity) => `${entity.entity_type}\u0000${entity.id}`),
  );
  for (const entity of snapshot.entities) {
    const project = projects.get(entity.project_id);
    if (!project) {
      conflicts.push(
        finding(
          "entity_without_project",
          entity.project_id,
          "Current entity references a missing Project.",
          {
            entity_type: entity.entity_type,
            entity_id: entity.id,
            entity_key: entity.key,
          },
        ),
      );
    } else if (entity.workspace_id !== project.workspace_id) {
      conflicts.push(
        finding(
          "entity_project_workspace_mismatch",
          entity.project_id,
          "Entity and Project workspace differ.",
          {
            entity_type: entity.entity_type,
            entity_id: entity.id,
            entity_key: entity.key,
          },
        ),
      );
    }
  }
  for (const revision of snapshot.revisions) {
    const project = projects.get(revision.project_id);
    if (!project) {
      conflicts.push(
        finding(
          "revision_without_project",
          revision.project_id,
          "Revision references a missing Project.",
          {
            entity_type: revision.entity_type,
            entity_id: revision.entity_id,
            path: `revision.${String(revision.revision)}`,
          },
        ),
      );
    } else if (
      revision.workspace_id !== project.workspace_id &&
      !currentEntity.has(`${revision.entity_type}\u0000${revision.entity_id}`)
    ) {
      conflicts.push(
        finding(
          "revision_project_workspace_mismatch",
          revision.project_id,
          "Revision and Project workspace differ.",
          {
            entity_type: revision.entity_type,
            entity_id: revision.entity_id,
            path: `revision.${String(revision.revision)}`,
          },
        ),
      );
    }
  }
  for (const link of snapshot.links) {
    const project = projects.get(link.project_id);
    if (!project) {
      conflicts.push(
        finding("link_without_project", link.project_id, "Link references a missing Project.", {
          path: `entity_link.${link.id}`,
        }),
      );
    }
  }
  if (!snapshot.capabilities.rule_table || !snapshot.capabilities.rule_counter) {
    warnings.push(
      finding(
        "rule_storage_not_deployed",
        null,
        "Rule table/counter is not deployed yet; preflight remains valid but apply cannot start.",
      ),
    );
  }
  if (!snapshot.capabilities.milestone_table || !snapshot.capabilities.milestone_counter) {
    warnings.push(
      finding(
        "milestone_storage_not_deployed",
        null,
        "Milestone table/counter is not deployed yet; preflight remains valid but apply cannot start.",
      ),
    );
  }
  return { conflicts: conflicts.sort(findingOrder), warnings: warnings.sort(findingOrder) };
};

/** Builds the complete deterministic, write-free migration manifest. */
export function buildV2PreflightReport(snapshot: DatabaseSnapshot): V2PreflightReport {
  const global = globalFindings(snapshot);
  const projects = [...snapshot.projects]
    .sort(
      (left, right) =>
        textOrder(left.workspace_id, right.workspace_id) || textOrder(left.id, right.id),
    )
    .map((project) => buildProjectReport(snapshot, project));
  const conflictCount =
    global.conflicts.length +
    projects.reduce((count, project) => count + project.conflicts.length, 0);
  const warningCount =
    global.warnings.length +
    projects.reduce((count, project) => count + project.warnings.length, 0);
  return {
    report_version: "zpecs.v2.preflight.v1",
    target_schema_versions: {
      epic: "pm.epic.v2",
      stream: "pm.stream.v2",
      task: "pm.task.v2",
      rule: "pm.rule.v2",
      milestone: "pm.milestone.v2",
    },
    deterministic: true,
    writes_performed: false,
    database_capabilities: snapshot.capabilities,
    apply: {
      status: "not_ready",
      reason:
        "The writer is intentionally disabled until Rule revision reconstruction, claim-level Evidence mapping, terminal Stream/Rule pins, and the final service cutover are losslessly specified.",
    },
    summary: {
      projects: projects.length,
      current_entities: snapshot.entities.length,
      revisions: snapshot.revisions.length,
      links: snapshot.links.length,
      conflicts: conflictCount,
      warnings: warningCount,
    },
    projects,
    conflicts: global.conflicts,
    warnings: global.warnings,
  };
}
