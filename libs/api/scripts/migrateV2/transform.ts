import { parseDocument } from "../../src/domain/schema/document";
import {
  sha256,
  type LocalIdMapping,
  type ProjectPreflightReport,
  type RuleGroup,
  type V2PreflightReport,
} from "./preflight";
import type {
  CurrentEntitySnapshot,
  DatabaseSnapshot,
  HierarchyEntityType,
  ProjectSnapshot,
} from "./readSnapshot";
import { STREAM_RESOLUTIONS, type StreamResolution } from "./resolutions";

type ObjectValue = Record<string, unknown>;

export type PlannedEntityBaseline = {
  readonly entityType: HierarchyEntityType;
  readonly entityId: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly legacyKey: string;
  readonly key: string;
  readonly previousRevision: number;
  readonly revision: number;
  readonly status: string;
  readonly title: string;
  readonly summary: string;
  readonly beforeDocumentSha256: string;
  readonly documentSha256: string;
  readonly document: ObjectValue;
};

export type PlannedRuleBaseline = {
  readonly entityId: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly key: string;
  readonly legacyId: string;
  readonly legacyContentSha256: string;
  readonly status: "active";
  readonly revision: 1;
  readonly title: string;
  readonly summary: string;
  readonly documentSha256: string;
  readonly document: ObjectValue;
};

export type ProjectCounterPlan = {
  readonly projectId: string;
  readonly epic: number;
  readonly stream: number;
  readonly task: number;
  readonly milestone: number;
  readonly rule: number;
};

export type PlannedStreamResolution = {
  readonly entityId: string;
  readonly legacyKey: string;
  readonly key: string;
  readonly expectedRevision: number;
  readonly expectedDocumentSha256: string;
  readonly statusBefore: string;
  readonly statusAfter: string;
  readonly addedContentFields: readonly string[];
  readonly assumptionId: string;
  readonly migrationAssumption: string;
};

export type V2MigrationPlan = {
  readonly planVersion: "zpecs.v2.apply.v1";
  readonly sourceAudit: {
    readonly currentRowsSha256: readonly { readonly projectId: string; readonly sha256: string }[];
    readonly revisionRowsSha256: readonly { readonly projectId: string; readonly sha256: string }[];
    readonly linkRowsSha256: readonly { readonly projectId: string; readonly sha256: string }[];
  };
  readonly entities: readonly PlannedEntityBaseline[];
  readonly rules: readonly PlannedRuleBaseline[];
  readonly counters: readonly ProjectCounterPlan[];
  readonly resolutions: readonly PlannedStreamResolution[];
  readonly decisions: readonly string[];
  readonly issues: readonly string[];
};

const recordOf = (value: unknown): ObjectValue =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as ObjectValue)
    : {};

const arrayOf = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);

const textOf = (value: unknown): string | null => (typeof value === "string" ? value : null);

const clone = <T>(value: T): T => structuredClone(value);

const numberedOrder = (left: string, right: string): number => {
  const leftMatch = /^(.*?)([0-9]+)$/.exec(left);
  const rightMatch = /^(.*?)([0-9]+)$/.exec(right);
  if (leftMatch && rightMatch && leftMatch[1] === rightMatch[1]) {
    return Number(leftMatch[2]) - Number(rightMatch[2]) || left.localeCompare(right);
  }
  return left.localeCompare(right);
};

/** Stable UUID so a reviewed dry-run and the eventual locked apply name identical Rules. */
const uuidFromSeed = (seed: string): string => {
  const bytes = Uint8Array.from(sha256(seed).slice(0, 32).match(/.{2}/g) ?? [], (pair) =>
    Number.parseInt(pair, 16),
  );
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const schemaVersion = (entity: HierarchyEntityType): string => `pm.${entity}.v2`;

const mappingsFor = (report: ProjectPreflightReport, entityId: string): readonly LocalIdMapping[] =>
  report.local_id_mappings.filter((mapping) => mapping.entity_id === entityId);

const mappedId = (mappings: readonly LocalIdMapping[], sourcePath: string): string | null =>
  mappings.find((mapping) => mapping.source_path === sourcePath)?.v2_id ?? null;

const requireMappedId = (mappings: readonly LocalIdMapping[], sourcePath: string): string => {
  const id = mappedId(mappings, sourcePath);
  if (id === null) throw new Error(`No v2 local id was allocated for ${sourcePath}.`);
  return id;
};

const mapItemIds = (
  values: unknown,
  sourcePath: string,
  mappings: readonly LocalIdMapping[],
): unknown[] =>
  arrayOf(values).map((value, index) => ({
    ...recordOf(value),
    id: requireMappedId(mappings, `${sourcePath}[${String(index)}]`),
  }));

const mapScope = (
  value: unknown,
  sourcePath: string,
  mappings: readonly LocalIdMapping[],
): ObjectValue | undefined => {
  if (value === undefined) return undefined;
  const scope = recordOf(value);
  return {
    included: mapItemIds(scope.included, `${sourcePath}.included`, mappings),
    excluded: mapItemIds(scope.excluded, `${sourcePath}.excluded`, mappings),
  };
};

const mapTextItems = (
  values: unknown,
  sourcePath: string,
  mappings: readonly LocalIdMapping[],
  field: "question" | "statement",
): ObjectValue[] =>
  arrayOf(values).map((value, index) => {
    const object = recordOf(value);
    const text = typeof value === "string" ? value : object[field];
    if (typeof text !== "string") {
      throw new Error(`${sourcePath}[${String(index)}] is not legacy text or a typed item.`);
    }
    return {
      id: requireMappedId(mappings, `${sourcePath}[${String(index)}]`),
      [field]: text,
      ...(field === "statement" && Array.isArray(object.source_ids)
        ? { source_ids: object.source_ids }
        : {}),
    };
  });

const nextLocalId = (items: readonly unknown[], prefix: string): string => {
  const used = new Set(
    items.flatMap((item) => {
      const id = textOf(recordOf(item).id);
      const match = id === null ? null : new RegExp(`^${prefix}-([1-9][0-9]*)$`).exec(id);
      return match ? [Number(match[1])] : [];
    }),
  );
  let sequence = 1;
  while (used.has(sequence)) sequence += 1;
  return `${prefix}-${String(sequence)}`;
};

const appendAssumption = (content: ObjectValue, statement: string): void => {
  const assumptions = [...arrayOf(content.assumptions)];
  assumptions.push({ id: nextLocalId(assumptions, "ASM"), statement });
  content.assumptions = assumptions;
};

const appendOpenQuestion = (content: ObjectValue, question: string): void => {
  const questions = [...arrayOf(content.open_questions)];
  questions.push({ id: nextLocalId(questions, "OQ"), question });
  content.open_questions = questions;
};

type RuleAllocation = {
  readonly group: RuleGroup;
  readonly key: string;
  readonly entityId: string;
  readonly title: string;
};

const allocateRules = (
  project: ProjectSnapshot,
  report: ProjectPreflightReport,
): readonly RuleAllocation[] => {
  if (report.counts.current.rule !== 0 || (project.rule_counter ?? 0) !== 0) {
    throw new Error(
      `${project.name} already contains v2 Rules; baseline migration is not retryable.`,
    );
  }
  const groups = [...report.rules.groups].sort(
    (left, right) =>
      numberedOrder(left.legacy_id, right.legacy_id) ||
      left.content_sha256.localeCompare(right.content_sha256),
  );
  const variantsByLegacyId = new Map<string, number>();
  for (const group of groups) {
    variantsByLegacyId.set(group.legacy_id, (variantsByLegacyId.get(group.legacy_id) ?? 0) + 1);
  }
  return groups.map((group, index) => {
    const key = `R-${String(index + 1)}`;
    const variant = (variantsByLegacyId.get(group.legacy_id) ?? 0) > 1;
    return {
      group,
      key,
      entityId: uuidFromSeed(
        `zpecs-v2-rule:${project.id}:${group.legacy_id}:${group.content_sha256}`,
      ),
      title: variant ? `${group.legacy_id} (${group.content_sha256.slice(0, 8)})` : group.legacy_id,
    };
  });
};

const ruleOccurrenceMap = (rules: readonly RuleAllocation[]): ReadonlyMap<string, RuleAllocation> =>
  new Map(
    rules.flatMap((rule) =>
      rule.group.occurrences.map(
        (occurrence) => [`${occurrence.owner_id}\u0000${occurrence.path}`, rule] as const,
      ),
    ),
  );

const ruleByLegacyId = (
  rules: readonly RuleAllocation[],
  legacyId: string,
): RuleAllocation | null => {
  const matches = rules.filter((rule) => rule.group.legacy_id === legacyId);
  return matches.length === 1 ? (matches[0] ?? null) : null;
};

const transformProvenance = (
  document: ObjectValue,
  mappings: readonly LocalIdMapping[],
): ObjectValue => {
  const provenance = recordOf(document.provenance);
  const sources = arrayOf(provenance.sources).map((value, index) => {
    const source = recordOf(value);
    const reference = textOf(source.reference);
    if (reference === null) {
      throw new Error(`provenance.sources[${String(index)}].reference is required by v2.`);
    }
    return {
      id: requireMappedId(mappings, `provenance.sources[${String(index)}]`),
      type: source.type,
      reference,
    };
  });
  return sources.length === 0 ? {} : { sources };
};

const transformCommonContent = (
  document: ObjectValue,
  mappings: readonly LocalIdMapping[],
  rules: ReadonlyMap<string, RuleAllocation>,
): ObjectValue => {
  const original = recordOf(document.content);
  const content = clone(original);

  const scope = mapScope(original.scope, "content.scope", mappings);
  if (scope !== undefined) content.scope = scope;

  if (original.workflows !== undefined) {
    content.workflows = mapItemIds(original.workflows, "content.workflows", mappings).map(
      (workflow, workflowIndex) => {
        const item = recordOf(workflow);
        return {
          ...item,
          steps: mapItemIds(
            item.steps,
            `content.workflows.${String(workflowIndex)}.steps`,
            mappings,
          ),
        };
      },
    );
  }
  if (original.edge_cases !== undefined) {
    content.edge_cases = mapItemIds(original.edge_cases, "content.edge_cases", mappings);
  }

  const contentQuestions = mapTextItems(
    original.open_questions,
    "content.open_questions",
    mappings,
    "question",
  );
  const provenanceQuestions = mapTextItems(
    recordOf(document.provenance).open_questions,
    "provenance.open_questions",
    mappings,
    "question",
  );
  const questions = [...contentQuestions, ...provenanceQuestions];
  if (questions.length > 0) content.open_questions = questions;
  else delete content.open_questions;

  const contentAssumptions = mapTextItems(
    original.assumptions,
    "content.assumptions",
    mappings,
    "statement",
  );
  const provenanceAssumptions = mapTextItems(
    recordOf(document.provenance).assumptions,
    "provenance.assumptions",
    mappings,
    "statement",
  );
  const assumptions = [...contentAssumptions, ...provenanceAssumptions];
  if (assumptions.length > 0) content.assumptions = assumptions;
  else delete content.assumptions;

  const legacyRules = arrayOf(original.business_rules);
  if (legacyRules.length > 0) {
    content.rule_applications = legacyRules.map((_, index) => {
      const path = `content.business_rules[${String(index)}]`;
      const rule = rules.get(path);
      if (rule === undefined) throw new Error(`No canonical Rule was allocated for ${path}.`);
      return {
        id: requireMappedId(mappings, path),
        rule_key: rule.key,
      };
    });
  }
  delete content.business_rules;
  return content;
};

const transformEpicContent = (
  entity: CurrentEntitySnapshot,
  report: ProjectPreflightReport,
  allocations: readonly RuleAllocation[],
): ObjectValue => {
  const mappings = mappingsFor(report, entity.id);
  const rules = new Map<string, RuleAllocation>();
  for (const [compound, allocation] of ruleOccurrenceMap(allocations)) {
    const [ownerId, path] = compound.split("\u0000");
    if (ownerId === entity.id && path) rules.set(path, allocation);
  }
  const original = recordOf(entity.document.content);
  const content = transformCommonContent(entity.document, mappings, rules);
  if (original.outcomes !== undefined) {
    content.outcomes = mapItemIds(original.outcomes, "content.outcomes", mappings);
  }
  if (original.success_metrics !== undefined) {
    content.success_metrics = mapItemIds(
      original.success_metrics,
      "content.success_metrics",
      mappings,
    );
  }
  for (const inferred of arrayOf(recordOf(entity.document.provenance).inferred_fields)) {
    if (typeof inferred !== "string") continue;
    if (inferred === "open_questions") continue;
    if (inferred === "outcomes" || inferred === "outcomes.indicator") {
      content.outcomes = arrayOf(content.outcomes).map((value) => {
        const outcome = recordOf(value);
        if (inferred === "outcomes.indicator" && outcome.indicator === undefined) return outcome;
        return { ...outcome, evidence: { basis: "assumed" } };
      });
      continue;
    }
    appendAssumption(content, inferred);
  }
  return content;
};

const transformAcceptanceCriteria = (
  entity: CurrentEntitySnapshot,
  original: ObjectValue,
  mappings: readonly LocalIdMapping[],
  report: ProjectPreflightReport,
  allocations: readonly RuleAllocation[],
): ObjectValue[] =>
  arrayOf(original.acceptance_criteria).map((value, criterionIndex) => {
    const criterion = recordOf(value);
    const raw = criterion.verifies;
    const references: { legacy: string; path: string }[] = [];
    if (Array.isArray(raw)) {
      raw.forEach((legacy, index) => {
        if (typeof legacy === "string") {
          references.push({
            legacy,
            path: `content.acceptance_criteria[${String(criterionIndex)}].verifies[${String(index)}]`,
          });
        }
      });
    } else {
      const typed = recordOf(raw);
      for (const field of ["requirement_ids", "rule_keys"] as const) {
        arrayOf(typed[field]).forEach((legacy, index) => {
          if (typeof legacy === "string") {
            references.push({
              legacy,
              path: `content.acceptance_criteria[${String(criterionIndex)}].verifies.${field}[${String(index)}]`,
            });
          }
        });
      }
    }
    const requirementIds: string[] = [];
    const ruleKeys: string[] = [];
    for (const reference of references) {
      const preflight = report.structured_references.find(
        (item) => item.owner_id === entity.id && item.path === reference.path,
      );
      if (preflight?.kind === "acceptance_criterion_requirement") {
        if (preflight.v2_value === null) throw new Error(`${reference.path} did not resolve.`);
        requirementIds.push(preflight.v2_value);
        continue;
      }
      if (preflight?.kind === "acceptance_criterion_rule") {
        const rule = ruleByLegacyId(allocations, reference.legacy);
        if (rule === null) throw new Error(`${reference.path} has no unique canonical Rule.`);
        ruleKeys.push(rule.key);
        continue;
      }
      throw new Error(`${reference.path} has no unambiguous v2 reference kind.`);
    }
    const verifies = {
      ...(requirementIds.length > 0 ? { requirement_ids: requirementIds } : {}),
      ...(ruleKeys.length > 0 ? { rule_keys: ruleKeys } : {}),
    };
    return {
      ...criterion,
      id: requireMappedId(mappings, `content.acceptance_criteria[${String(criterionIndex)}]`),
      ...(references.length > 0 ? { verifies } : {}),
    };
  });

const transformStreamContent = (
  entity: CurrentEntitySnapshot,
  report: ProjectPreflightReport,
  allocations: readonly RuleAllocation[],
  resolution: StreamResolution | undefined,
): ObjectValue => {
  const mappings = mappingsFor(report, entity.id);
  const rules = new Map<string, RuleAllocation>();
  for (const [compound, allocation] of ruleOccurrenceMap(allocations)) {
    const [ownerId, path] = compound.split("\u0000");
    if (ownerId === entity.id && path) rules.set(path, allocation);
  }
  const original = recordOf(entity.document.content);
  const content = transformCommonContent(entity.document, mappings, rules);
  const discovery = mapScope(original.discovery_scope, "content.discovery_scope", mappings);
  if (discovery !== undefined) content.discovery_scope = discovery;

  switch (entity.subtype) {
    case "feature": {
      const requirements = recordOf(original.requirements);
      if (original.requirements !== undefined) {
        content.requirements = {
          ...(requirements.functional !== undefined
            ? {
                functional: mapItemIds(
                  requirements.functional,
                  "content.requirements.functional",
                  mappings,
                ),
              }
            : {}),
          ...(requirements.non_functional !== undefined
            ? {
                non_functional: mapItemIds(
                  requirements.non_functional,
                  "content.requirements.non_functional",
                  mappings,
                ),
              }
            : {}),
        };
      }
      if (original.acceptance_criteria !== undefined) {
        content.acceptance_criteria = transformAcceptanceCriteria(
          entity,
          original,
          mappings,
          report,
          allocations,
        );
      }
      break;
    }
    case "bug": {
      if (original.behavior_cases !== undefined) {
        content.behavior_cases = mapItemIds(
          original.behavior_cases,
          "content.behavior_cases",
          mappings,
        );
      } else if (
        original.actual_behavior !== undefined ||
        original.expected_behavior !== undefined ||
        original.reproduction !== undefined ||
        original.severity !== undefined
      ) {
        if (
          typeof original.actual_behavior !== "string" ||
          typeof original.expected_behavior !== "string"
        ) {
          throw new Error(`${entity.key} has a partial legacy bug behavior case.`);
        }
        content.behavior_cases = [
          {
            id: requireMappedId(
              mappings,
              "content.{reproduction,actual_behavior,expected_behavior,severity}",
            ),
            ...(original.reproduction === undefined ? {} : { reproduction: original.reproduction }),
            actual_behavior: original.actual_behavior,
            expected_behavior: original.expected_behavior,
            ...(original.severity === undefined ? {} : { severity: original.severity }),
          },
        ];
      }
      for (const field of ["reproduction", "actual_behavior", "expected_behavior", "severity"]) {
        delete content[field];
      }
      break;
    }
    case "investigation": {
      if (original.questions !== undefined) {
        content.questions = mapItemIds(original.questions, "content.questions", mappings);
      }
      if (original.success_criteria !== undefined) {
        content.success_criteria = mapItemIds(
          original.success_criteria,
          "content.success_criteria",
          mappings,
        );
      }
      break;
    }
    case "change":
    case "experiment":
    case "maintenance":
    case "refactor": {
      for (const field of [
        "changes",
        "hypotheses",
        "research_questions",
        "success_criteria",
        "decision_rules",
        "maintenance_goals",
        "risks",
        "refactor_targets",
        "invariants",
        "quality_goals",
      ]) {
        if (original[field] === undefined) continue;
        content[field] = mapItemIds(original[field], `content.${field}`, mappings);
      }
      break;
    }
    default:
      throw new Error(`${entity.key} has unsupported Stream type ${String(entity.subtype)}.`);
  }

  for (const inferred of arrayOf(recordOf(entity.document.provenance).inferred_fields)) {
    if (typeof inferred === "string" && inferred !== "open_questions") {
      appendAssumption(content, inferred);
    }
  }
  if (resolution !== undefined) {
    Object.assign(content, clone(resolution.content));
    appendAssumption(content, resolution.migrationAssumption);
  }
  return content;
};

const historicalReferenceQuestion = (legacy: string): string =>
  `Der historische Verweis ${legacy} war im v1-Snapshot STR-14@1 vorhanden; weil der Task-Verlauf vor v2 nicht aufgezeichnet wurde und der aktuelle Elternstream den Eintrag nicht mehr enthält, bleibt seine heutige fachliche Zuordnung bewusst ungepinnt.`;

const allowedHistoricalReference = (entity: CurrentEntitySnapshot, legacy: string): boolean =>
  (entity.key === "TASK-19" && (legacy === "AC-DECKEL" || legacy === "FR-FREMDHOST")) ||
  (entity.key === "TASK-21" && legacy === "FR-LIEFERPREISE");

const transformTaskContent = (
  entity: CurrentEntitySnapshot,
  report: ProjectPreflightReport,
  allocations: readonly RuleAllocation[],
): ObjectValue => {
  const mappings = mappingsFor(report, entity.id);
  const original = recordOf(entity.document.content);
  const content = transformCommonContent(entity.document, mappings, new Map());
  delete content.rule_applications;
  if (original.verification !== undefined) {
    content.verification = mapItemIds(original.verification, "content.verification", mappings);
  }
  const implementation = recordOf(original.implements);
  if (original.implements !== undefined) {
    const transformed: ObjectValue = { stream_id: entity.parent_id };
    for (const [field, values] of Object.entries(implementation)) {
      if (field === "stream_id" || !Array.isArray(values)) continue;
      const mapped: string[] = [];
      values.forEach((legacy, index) => {
        if (typeof legacy !== "string") return;
        const path = `content.implements.${field}[${String(index)}]`;
        const reference = report.structured_references.find(
          (item) => item.owner_id === entity.id && item.path === path,
        );
        if (reference?.v2_value !== null && reference?.v2_value !== undefined) {
          mapped.push(reference.v2_value);
        } else if (allowedHistoricalReference(entity, legacy)) {
          appendOpenQuestion(content, historicalReferenceQuestion(legacy));
        } else {
          throw new Error(`${entity.key}.${path} did not resolve to v2.`);
        }
      });
      if (mapped.length > 0) transformed[field] = mapped;
    }
    content.implements = transformed;
  }
  if (Array.isArray(original.constrained_by_rule_keys)) {
    content.constrained_by_rule_keys = original.constrained_by_rule_keys.map((legacy) => {
      if (typeof legacy !== "string") throw new Error(`${entity.key} has a non-string Rule key.`);
      const rule = ruleByLegacyId(allocations, legacy);
      if (rule === null)
        throw new Error(`${entity.key} Rule ${legacy} is not uniquely resolvable.`);
      return rule.key;
    });
  }
  for (const inferred of arrayOf(recordOf(entity.document.provenance).inferred_fields)) {
    if (typeof inferred === "string" && inferred !== "open_questions") {
      appendAssumption(content, inferred);
    }
  }
  return content;
};

const buildMeta = (
  entity: CurrentEntitySnapshot,
  key: string,
  revision: number,
  resolution: StreamResolution | undefined,
): ObjectValue => ({
  id: entity.id,
  key,
  revision,
  title: entity.title,
  status: resolution?.status ?? entity.status,
  ...(recordOf(entity.document.meta).priority === undefined
    ? {}
    : { priority: recordOf(entity.document.meta).priority }),
  ...(entity.entity_type === "stream" ? { stream_type: entity.subtype } : {}),
  ...(entity.entity_type === "task" ? { task_type: entity.subtype } : {}),
});

const buildExecution = (entity: CurrentEntitySnapshot): ObjectValue | undefined => {
  if (entity.entity_type !== "task") return undefined;
  const execution = clone(recordOf(entity.document.execution));
  delete execution.stream_revision_started;
  delete execution.stream_revision_used;
  delete execution.rule_revisions_used;
  delete execution.trace_state;
  if (entity.status === "done") execution.trace_state = "pre_v2_not_recorded";
  return Object.keys(execution).length === 0 ? undefined : execution;
};

const buildRulePlans = (
  project: ProjectSnapshot,
  allocations: readonly RuleAllocation[],
): readonly PlannedRuleBaseline[] =>
  allocations.map((allocation) => {
    const body = recordOf(allocation.group.occurrences[0]?.content);
    const statement = textOf(body.rule);
    if (statement === null) throw new Error(`${allocation.group.legacy_id} has no Rule statement.`);
    const content = {
      statement,
      ...(body.impact === undefined ? {} : { impact: body.impact }),
      ...(body.consequence === undefined ? {} : { consequence: body.consequence }),
    };
    const document = {
      entity: "rule",
      schema_version: "pm.rule.v2",
      meta: {
        id: allocation.entityId,
        key: allocation.key,
        revision: 1,
        title: allocation.title,
        status: "active",
      },
      content,
      links: {},
      provenance: {},
    };
    return {
      entityId: allocation.entityId,
      workspaceId: project.workspace_id,
      projectId: project.id,
      key: allocation.key,
      legacyId: allocation.group.legacy_id,
      legacyContentSha256: allocation.group.content_sha256,
      status: "active",
      revision: 1,
      title: allocation.title,
      summary: statement,
      documentSha256: sha256(document),
      document,
    };
  });

const entityReferenceIssues = (
  entities: readonly PlannedEntityBaseline[],
  rules: readonly PlannedRuleBaseline[],
): string[] => {
  const issues: string[] = [];
  const ruleKeys = new Set(rules.map((rule) => rule.key));
  const streamById = new Map(
    entities
      .filter((entity) => entity.entityType === "stream")
      .map((entity) => [entity.entityId, entity]),
  );
  for (const entity of entities) {
    const document = entity.document;
    const visitRules = (value: unknown, path: string): void => {
      if (Array.isArray(value)) {
        value.forEach((item, index) => visitRules(item, `${path}[${String(index)}]`));
        return;
      }
      if (typeof value !== "object" || value === null) return;
      for (const [key, child] of Object.entries(value as ObjectValue)) {
        const childPath = path.length === 0 ? key : `${path}.${key}`;
        if (key === "rule_key" && typeof child === "string" && !ruleKeys.has(child)) {
          issues.push(`${entity.key}.${childPath} references missing ${child}.`);
        } else if (
          (key === "rule_keys" || key === "constrained_by_rule_keys") &&
          Array.isArray(child)
        ) {
          child.forEach((candidate, index) => {
            if (typeof candidate === "string" && !ruleKeys.has(candidate)) {
              issues.push(
                `${entity.key}.${childPath}[${String(index)}] references missing ${candidate}.`,
              );
            }
          });
        }
        visitRules(child, childPath);
      }
    };
    visitRules(document, "");

    if (entity.entityType !== "task") continue;
    const implementation = recordOf(recordOf(document.content).implements);
    const streamId = textOf(implementation.stream_id);
    const parent = streamId === null ? undefined : streamById.get(streamId);
    if (parent === undefined) {
      issues.push(`${entity.key}.content.implements.stream_id has no migrated parent Stream.`);
      continue;
    }
    const parentContent = recordOf(parent.document.content);
    const targetIds = new Set<string>();
    const collectIds = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(collectIds);
      else if (typeof value === "object" && value !== null) {
        const object = value as ObjectValue;
        if (typeof object.id === "string") targetIds.add(object.id);
        Object.values(object).forEach(collectIds);
      }
    };
    collectIds(parentContent);
    for (const [field, values] of Object.entries(implementation)) {
      if (field === "stream_id" || !Array.isArray(values)) continue;
      values.forEach((id, index) => {
        if (typeof id === "string" && !targetIds.has(id)) {
          issues.push(`${entity.key}.content.implements.${field}[${String(index)}] misses ${id}.`);
        }
      });
    }
  }
  return issues;
};

const expectedConflictCodes = new Set([
  "same_rule_id_different_content",
  "inferred_field_needs_claim_mapping",
  "ready_stream_missing_v2_targets",
  "unresolved_structured_reference",
]);

const assertResolutionBindings = (
  snapshot: DatabaseSnapshot,
  resolutions: readonly StreamResolution[],
): string[] => {
  const issues: string[] = [];
  const entityById = new Map(snapshot.entities.map((entity) => [entity.id, entity]));
  for (const resolution of resolutions) {
    const entity = entityById.get(resolution.entityId);
    if (
      entity === undefined ||
      entity.entity_type !== "stream" ||
      entity.key !== resolution.legacyKey ||
      entity.revision !== resolution.expectedRevision ||
      sha256(entity.document) !== resolution.expectedDocumentSha256
    ) {
      issues.push(`${resolution.legacyKey} no longer matches its reviewed migration binding.`);
    }
  }
  return issues;
};

/** Pure, deterministic v1 snapshot → fully validated v2 write plan. */
export function buildV2MigrationPlan(
  snapshot: DatabaseSnapshot,
  report: V2PreflightReport,
): V2MigrationPlan {
  const issues = assertResolutionBindings(snapshot, STREAM_RESOLUTIONS);
  if (report.conflicts.some((finding) => !expectedConflictCodes.has(finding.code))) {
    issues.push(...report.conflicts.map((finding) => `global:${finding.code}:${finding.message}`));
  }
  const plannedEntities: PlannedEntityBaseline[] = [];
  const plannedRules: PlannedRuleBaseline[] = [];
  const counters: ProjectCounterPlan[] = [];
  const decisions: string[] = [];

  for (const project of snapshot.projects) {
    const projectReport = report.projects.find((candidate) => candidate.project_id === project.id);
    if (projectReport === undefined) {
      issues.push(`Project ${project.id} has no preflight report.`);
      continue;
    }
    for (const conflict of projectReport.conflicts) {
      if (!expectedConflictCodes.has(conflict.code)) {
        issues.push(`${project.name}:${conflict.code}:${conflict.message}`);
      }
    }
    const projectEntities = snapshot.entities.filter((entity) => entity.project_id === project.id);
    if (
      projectEntities.some(
        (entity) => entity.entity_type === "rule" || entity.entity_type === "milestone",
      )
    ) {
      issues.push(
        `${project.name} already has Rule or Milestone rows; v1 baseline apply is not allowed.`,
      );
      continue;
    }
    const hierarchy = projectEntities.filter(
      (entity): entity is CurrentEntitySnapshot & { readonly entity_type: HierarchyEntityType } =>
        entity.entity_type === "epic" ||
        entity.entity_type === "stream" ||
        entity.entity_type === "task",
    );
    const allocations = allocateRules(project, projectReport);
    const rules = buildRulePlans(project, allocations);
    plannedRules.push(...rules);
    const keyById = new Map(
      projectReport.key_mappings.map((mapping) => [mapping.entity_id, mapping.v2_key]),
    );

    for (const entity of hierarchy) {
      const key = keyById.get(entity.id);
      if (key === null || key === undefined) {
        issues.push(`${entity.key} has no v2 entity key.`);
        continue;
      }
      const resolution = STREAM_RESOLUTIONS.find((item) => item.entityId === entity.id);
      const mappings = mappingsFor(projectReport, entity.id);
      const content =
        entity.entity_type === "epic"
          ? transformEpicContent(entity, projectReport, allocations)
          : entity.entity_type === "stream"
            ? transformStreamContent(entity, projectReport, allocations, resolution)
            : transformTaskContent(entity, projectReport, allocations);
      const revision = entity.revision + 1;
      const document: ObjectValue = {
        entity: entity.entity_type,
        schema_version: schemaVersion(entity.entity_type),
        meta: buildMeta(entity, key, revision, resolution),
        content,
        links:
          entity.entity_type === "epic"
            ? {}
            : entity.entity_type === "stream"
              ? { parent_epic_id: entity.parent_id }
              : { parent_stream_id: entity.parent_id },
        provenance: transformProvenance(entity.document, mappings),
        ...(entity.entity_type === "task" && buildExecution(entity) !== undefined
          ? { execution: buildExecution(entity) }
          : {}),
      };
      const parsed = parseDocument(document, { source: "store" });
      if (!parsed.ok) {
        issues.push(
          ...parsed.issues.map((issue) => `${entity.key}:${issue.path}:${issue.message}`),
        );
      }
      const summary =
        textOf(content[entity.entity_type === "task" ? "objective" : "purpose"]) ?? "";
      plannedEntities.push({
        entityType: entity.entity_type,
        entityId: entity.id,
        workspaceId: entity.workspace_id,
        projectId: entity.project_id,
        legacyKey: entity.key,
        key,
        previousRevision: entity.revision,
        revision,
        status: textOf(recordOf(document.meta).status) ?? entity.status,
        title: entity.title,
        summary,
        beforeDocumentSha256: sha256(entity.document),
        documentSha256: sha256(document),
        document,
      });
    }
    counters.push({
      projectId: project.id,
      epic: Math.max(project.epic_counter, projectReport.counters.observed_max.epic),
      stream: Math.max(project.stream_counter, projectReport.counters.observed_max.stream),
      task: Math.max(project.task_counter, projectReport.counters.observed_max.task),
      milestone: 0,
      rule: rules.length,
    });
  }

  for (const rule of plannedRules) {
    const parsed = parseDocument(rule.document, { source: "store" });
    if (!parsed.ok) {
      issues.push(...parsed.issues.map((issue) => `${rule.key}:${issue.path}:${issue.message}`));
    }
  }
  issues.push(...entityReferenceIssues(plannedEntities, plannedRules));

  const expectedCurrent = snapshot.entities.filter(
    (entity) =>
      entity.entity_type === "epic" ||
      entity.entity_type === "stream" ||
      entity.entity_type === "task",
  ).length;
  if (plannedEntities.length !== expectedCurrent) {
    issues.push(
      `Planned ${String(plannedEntities.length)} of ${String(expectedCurrent)} E/S/T baselines.`,
    );
  }
  const expectedOccurrences = report.projects.reduce(
    (count, project) => count + project.rules.occurrences.length,
    0,
  );
  const applicationCount = plannedEntities.reduce(
    (count, entity) => count + arrayOf(recordOf(entity.document.content).rule_applications).length,
    0,
  );
  if (applicationCount !== expectedOccurrences) {
    issues.push(
      `Planned ${String(applicationCount)} of ${String(expectedOccurrences)} Rule applications.`,
    );
  }

  const resolutions = STREAM_RESOLUTIONS.flatMap((resolution): PlannedStreamResolution[] => {
    const before = snapshot.entities.find((entity) => entity.id === resolution.entityId);
    const after = plannedEntities.find((entity) => entity.entityId === resolution.entityId);
    if (before === undefined || after === undefined) {
      issues.push(`${resolution.legacyKey} has no complete before/after resolution manifest.`);
      return [];
    }
    const assumptions = arrayOf(recordOf(after.document.content).assumptions).map(recordOf);
    const assumption = assumptions.find(
      (item) => item.statement === resolution.migrationAssumption,
    );
    const assumptionId = textOf(assumption?.id);
    if (assumptionId === null) {
      issues.push(`${resolution.legacyKey} is missing its migration assumption.`);
      return [];
    }
    return [
      {
        entityId: resolution.entityId,
        legacyKey: resolution.legacyKey,
        key: after.key,
        expectedRevision: resolution.expectedRevision,
        expectedDocumentSha256: resolution.expectedDocumentSha256,
        statusBefore: before.status,
        statusAfter: after.status,
        addedContentFields: Object.keys(resolution.content).sort(),
        assumptionId,
        migrationAssumption: resolution.migrationAssumption,
      },
    ];
  });
  if (resolutions.length !== STREAM_RESOLUTIONS.length) {
    issues.push(
      `Planned ${String(resolutions.length)} of ${String(STREAM_RESOLUTIONS.length)} reviewed Stream resolutions.`,
    );
  }

  decisions.push(
    `${String(plannedRules.length)} exact legacy-id/body Rule groups remain separate; no fuzzy or semantic merge was performed.`,
    "Legacy Source confidence remains in immutable v1 history; no claim received guessed source attribution.",
    "Seven completed Streams received hash-bound, assumed v2 target enrichments; S-46 was demoted from ready to planned.",
    "Thirty-six imported done Tasks are explicitly marked pre_v2_not_recorded; no historical revision pins were invented.",
    "Three STR-14@1 Task references were removed from current typed arrays and preserved verbatim as historical open questions.",
  );

  return {
    planVersion: "zpecs.v2.apply.v1",
    sourceAudit: {
      currentRowsSha256: report.projects.map((project) => ({
        projectId: project.project_id,
        sha256: project.audit.current_rows_sha256,
      })),
      revisionRowsSha256: report.projects.map((project) => ({
        projectId: project.project_id,
        sha256: project.audit.revision_rows_sha256,
      })),
      linkRowsSha256: report.projects.map((project) => ({
        projectId: project.project_id,
        sha256: project.audit.link_rows_sha256,
      })),
    },
    entities: plannedEntities.sort(
      (left, right) =>
        left.projectId.localeCompare(right.projectId) ||
        left.entityType.localeCompare(right.entityType) ||
        numberedOrder(left.key, right.key),
    ),
    rules: plannedRules.sort(
      (left, right) =>
        left.projectId.localeCompare(right.projectId) || numberedOrder(left.key, right.key),
    ),
    counters,
    resolutions,
    decisions,
    issues: [...new Set(issues)].sort(),
  };
}
