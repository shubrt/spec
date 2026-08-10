import type { StreamType } from "../enums";
import { shapeIssue, type DocumentIssue } from "./rules";
import { deriveSourceFreshness } from "./sourceFreshness";

type DefinitionGroup = {
  readonly value: unknown;
  readonly path: string;
};

const recordOf = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const arrayOf = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);

/** Reports every occurrence after the first one in one semantic local-id namespace. */
const duplicateIdIssues = (
  namespace: string,
  groups: readonly DefinitionGroup[],
): readonly DocumentIssue[] => {
  const firstPathById = new Map<string, string>();
  const issues: DocumentIssue[] = [];

  for (const group of groups) {
    arrayOf(group.value).forEach((item, index) => {
      const id = recordOf(item).id;
      if (typeof id !== "string") return;
      const path = `${group.path}[${String(index)}].id`;
      const firstPath = firstPathById.get(id);
      if (firstPath === undefined) {
        firstPathById.set(id, path);
      } else {
        issues.push(
          shapeIssue(path, `${id} duplicates ${firstPath} in the ${namespace} namespace.`),
        );
      }
    });
  }
  return issues;
};

const scopeDefinitionGroups = (value: unknown, path: string): readonly DefinitionGroup[] => {
  const scope = recordOf(value);
  return [
    { value: scope.included, path: `${path}.included` },
    { value: scope.excluded, path: `${path}.excluded` },
  ];
};

const sharedContentIssues = (
  content: Record<string, unknown>,
  additionalScopeGroups: readonly DefinitionGroup[] = [],
): readonly DocumentIssue[] => {
  const issues: DocumentIssue[] = [
    ...duplicateIdIssues("scope", [
      ...scopeDefinitionGroups(content.scope, "content.scope"),
      ...additionalScopeGroups,
    ]),
    ...duplicateIdIssues("Rule application", [
      { value: content.rule_applications, path: "content.rule_applications" },
    ]),
    ...duplicateIdIssues("assumption", [
      { value: content.assumptions, path: "content.assumptions" },
    ]),
    ...duplicateIdIssues("open question", [
      { value: content.open_questions, path: "content.open_questions" },
    ]),
  ];

  return issues;
};

const epicContentIssues = (content: Record<string, unknown>): readonly DocumentIssue[] => [
  ...sharedContentIssues(content),
  ...duplicateIdIssues("outcome", [{ value: content.outcomes, path: "content.outcomes" }]),
  ...duplicateIdIssues("success metric", [
    { value: content.success_metrics, path: "content.success_metrics" },
  ]),
];

const baseStreamIssues = (
  content: Record<string, unknown>,
  additionalScopeGroups: readonly DefinitionGroup[] = [],
): readonly DocumentIssue[] => {
  const workflows = arrayOf(content.workflows);
  const issues: DocumentIssue[] = [
    ...sharedContentIssues(content, additionalScopeGroups),
    ...duplicateIdIssues("workflow", [{ value: workflows, path: "content.workflows" }]),
    ...duplicateIdIssues(
      "workflow step",
      workflows.map((workflow, workflowIndex) => ({
        value: recordOf(workflow).steps,
        path: `content.workflows[${String(workflowIndex)}].steps`,
      })),
    ),
    ...duplicateIdIssues("edge case", [{ value: content.edge_cases, path: "content.edge_cases" }]),
  ];
  return issues;
};

const streamContentIssues = (
  streamType: StreamType,
  content: Record<string, unknown>,
): readonly DocumentIssue[] => {
  const issues: DocumentIssue[] = [
    ...baseStreamIssues(
      content,
      streamType === "investigation"
        ? scopeDefinitionGroups(content.discovery_scope, "content.discovery_scope")
        : [],
    ),
  ];

  switch (streamType) {
    case "feature": {
      const requirements = recordOf(content.requirements);
      issues.push(
        ...duplicateIdIssues("requirement", [
          {
            value: requirements.functional,
            path: "content.requirements.functional",
          },
          {
            value: requirements.non_functional,
            path: "content.requirements.non_functional",
          },
        ]),
        ...duplicateIdIssues("acceptance criterion", [
          { value: content.acceptance_criteria, path: "content.acceptance_criteria" },
        ]),
      );
      break;
    }
    case "bug": {
      issues.push(
        ...duplicateIdIssues("behavior case", [
          { value: content.behavior_cases, path: "content.behavior_cases" },
        ]),
      );
      break;
    }
    case "change": {
      issues.push(
        ...duplicateIdIssues("change", [{ value: content.changes, path: "content.changes" }]),
      );
      break;
    }
    case "experiment": {
      issues.push(
        ...duplicateIdIssues("hypothesis", [
          { value: content.hypotheses, path: "content.hypotheses" },
        ]),
        ...duplicateIdIssues("research question", [
          { value: content.research_questions, path: "content.research_questions" },
        ]),
        ...duplicateIdIssues("success criterion", [
          { value: content.success_criteria, path: "content.success_criteria" },
        ]),
        ...duplicateIdIssues("decision rule", [
          { value: content.decision_rules, path: "content.decision_rules" },
        ]),
      );
      break;
    }
    case "investigation": {
      issues.push(
        ...duplicateIdIssues("investigation question", [
          { value: content.questions, path: "content.questions" },
        ]),
        ...duplicateIdIssues("success criterion", [
          { value: content.success_criteria, path: "content.success_criteria" },
        ]),
      );
      break;
    }
    case "refactor": {
      issues.push(
        ...duplicateIdIssues("refactor target", [
          { value: content.refactor_targets, path: "content.refactor_targets" },
        ]),
        ...duplicateIdIssues("invariant", [
          { value: content.invariants, path: "content.invariants" },
        ]),
        ...duplicateIdIssues("quality goal", [
          { value: content.quality_goals, path: "content.quality_goals" },
        ]),
      );
      break;
    }
    case "maintenance": {
      issues.push(
        ...duplicateIdIssues("maintenance goal", [
          { value: content.maintenance_goals, path: "content.maintenance_goals" },
        ]),
        ...duplicateIdIssues("risk", [{ value: content.risks, path: "content.risks" }]),
      );
      break;
    }
  }

  return issues;
};

const taskContentIssues = (content: Record<string, unknown>): readonly DocumentIssue[] => [
  ...duplicateIdIssues("verification", [
    { value: content.verification, path: "content.verification" },
  ]),
  ...duplicateIdIssues("assumption", [{ value: content.assumptions, path: "content.assumptions" }]),
  ...duplicateIdIssues("open question", [
    { value: content.open_questions, path: "content.open_questions" },
  ]),
];

const standaloneContentIssues = (
  content: Record<string, unknown>,
  entity: "rule" | "milestone",
): readonly DocumentIssue[] => [
  ...duplicateIdIssues("assumption", [{ value: content.assumptions, path: "content.assumptions" }]),
  ...duplicateIdIssues("open question", [
    { value: content.open_questions, path: "content.open_questions" },
  ]),
  ...(entity === "milestone"
    ? duplicateIdIssues("exit criterion", [
        { value: content.exit_criteria, path: "content.exit_criteria" },
      ])
    : []),
];

const evidenceIssues = (
  content: unknown,
  sourceIds: ReadonlySet<string>,
  staleSourceIds: ReadonlySet<string>,
  enforceFreshness: boolean,
): readonly DocumentIssue[] => {
  const issues: DocumentIssue[] = [];

  const inspectSourceIds = (value: unknown, path: string): void => {
    if (!Array.isArray(value)) return;
    value.forEach((sourceId, index) => {
      if (typeof sourceId === "string" && !sourceIds.has(sourceId)) {
        issues.push(
          shapeIssue(
            `${path}[${String(index)}]`,
            `${sourceId} does not exist in provenance.sources.`,
          ),
        );
      }
    });
  };

  const visit = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}[${String(index)}]`));
      return;
    }
    if (typeof value !== "object" || value === null) return;

    const object = value as Record<string, unknown>;
    const evidence = recordOf(object.evidence);
    if (Object.keys(evidence).length > 0) {
      const basis = evidence.basis;
      const sourceRefs = evidence.source_ids;
      if (
        (basis === "stated" || basis === "verified" || basis === "inferred") &&
        (!Array.isArray(sourceRefs) || sourceRefs.length === 0)
      ) {
        issues.push(
          shapeIssue(
            `${path}.evidence.source_ids`,
            `${String(basis)} evidence needs at least one local Source.`,
          ),
        );
      }
      inspectSourceIds(sourceRefs, `${path}.evidence.source_ids`);
      if (
        enforceFreshness &&
        basis !== "assumed" &&
        Array.isArray(sourceRefs) &&
        sourceRefs.length > 0 &&
        sourceRefs.every((sourceId) => typeof sourceId === "string" && staleSourceIds.has(sourceId))
      ) {
        issues.push(
          shapeIssue(
            `${path}.evidence.source_ids`,
            "Every Source supporting this active claim is known stale. Add a current Source, or keep the work below its active/readiness state.",
          ),
        );
      }
    }

    // Assumptions carry implicit `assumed` basis and therefore cite Sources directly.
    if (Object.hasOwn(object, "source_ids") && !Object.hasOwn(object, "basis")) {
      inspectSourceIds(object.source_ids, `${path}.source_ids`);
    }

    for (const [key, child] of Object.entries(object)) {
      if (key !== "evidence" && key !== "source_ids") {
        visit(child, `${path}.${key}`);
      }
    }
  };

  visit(content, "content");
  return issues;
};

const sourceGraphIssues = (
  sources: readonly Record<string, unknown>[],
  sourceIds: ReadonlySet<string>,
): readonly DocumentIssue[] => {
  const issues: DocumentIssue[] = [];
  const edges = new Map<string, readonly string[]>();
  sources.forEach((source, index) => {
    if (typeof source.id !== "string") return;
    const supersedes = arrayOf(source.supersedes_source_ids).filter(
      (id): id is string => typeof id === "string",
    );
    edges.set(source.id, supersedes);
    supersedes.forEach((id, referenceIndex) => {
      const path = `provenance.sources[${String(index)}].supersedes_source_ids[${String(referenceIndex)}]`;
      if (id === source.id) {
        issues.push(shapeIssue(path, "A Source cannot supersede itself."));
      } else if (!sourceIds.has(id)) {
        issues.push(shapeIssue(path, `${id} does not exist in provenance.sources.`));
      }
    });
  });

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string, path: readonly string[]): void => {
    if (visiting.has(id)) {
      issues.push(
        shapeIssue(
          "provenance.sources",
          `Source supersession must be acyclic; cycle: ${[...path, id].join(" -> ")}.`,
        ),
      );
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const target of edges.get(id) ?? []) {
      if (sourceIds.has(target)) visit(target, [...path, id]);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of edges.keys()) visit(id, []);
  return issues;
};

export type DocumentIntegrityInput = {
  readonly entity: "epic" | "stream" | "task" | "rule" | "milestone";
  readonly streamType?: StreamType;
  readonly content: unknown;
  readonly provenance: unknown;
  readonly status: string;
};

const enforcesFreshness = (entity: DocumentIntegrityInput["entity"], status: string): boolean => {
  switch (entity) {
    case "epic":
    case "rule": {
      return status === "active";
    }
    case "stream": {
      return status === "ready" || status === "in_progress";
    }
    case "task": {
      return status === "ready" || status === "in_progress" || status === "in_review";
    }
    case "milestone": {
      return status === "planned" || status === "active";
    }
  }
};

/** Runtime integrity checks that JSON Schema cannot express without hidden refinements. */
export const documentIntegrityIssues = (
  input: DocumentIntegrityInput,
): readonly DocumentIssue[] => {
  const content = recordOf(input.content);
  const provenance = recordOf(input.provenance);
  const sourceGroups = [{ value: provenance.sources, path: "provenance.sources" }];
  const sourceRows = arrayOf(provenance.sources).map(recordOf);
  const sourceIds = new Set(
    sourceRows.map((source) => source.id).filter((id): id is string => typeof id === "string"),
  );
  const freshness = deriveSourceFreshness(
    sourceRows.flatMap((source) =>
      typeof source.id === "string"
        ? [
            {
              id: source.id,
              supersedes_source_ids: arrayOf(source.supersedes_source_ids).filter(
                (id): id is string => typeof id === "string",
              ),
            },
          ]
        : [],
    ),
  );
  const staleSourceIds = new Set(
    [...freshness].filter(([, value]) => value === "stale").map(([id]) => id),
  );

  let contentIssues: readonly DocumentIssue[];
  switch (input.entity) {
    case "epic": {
      contentIssues = epicContentIssues(content);
      break;
    }
    case "stream": {
      contentIssues = streamContentIssues(input.streamType ?? "feature", content);
      break;
    }
    case "task": {
      contentIssues = taskContentIssues(content);
      break;
    }
    case "rule":
    case "milestone": {
      contentIssues = standaloneContentIssues(content, input.entity);
      break;
    }
  }

  return [
    ...duplicateIdIssues("Source", sourceGroups),
    ...sourceGraphIssues(sourceRows, sourceIds),
    ...contentIssues,
    ...evidenceIssues(
      content,
      sourceIds,
      staleSourceIds,
      enforcesFreshness(input.entity, input.status),
    ),
  ];
};
