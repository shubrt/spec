import {
  asArray,
  asNumber,
  asRecord,
  asText,
  asTextArray,
  contentOf,
  optionalText,
  type JsonObject,
} from "./documentValue";

/**
 * Reading a stored document into addressable specification fragments.
 *
 * ## Five shapes, not twenty-six
 *
 * Twenty-six document sections across five entity types do not need twenty-six
 * layouts. They need five, because only five sentence structures exist in the
 * data:
 *
 *   statement    scope, requirements, outcomes, metrics, hypotheses, questions,
 *                assumptions, goals, invariants, risks — an id and one sentence,
 *                optionally with labelled detail lines
 *   criterion    acceptance criteria — given, when, then as three labelled lines
 *   condition    edge cases and decision rules — condition → expected outcome
 *   transition   change targets, refactor targets, behaviour cases — is → to be
 *   workflow     an actor and numbered steps, each with its own result
 *
 * The shape is chosen from the section's actual structure, not from its name. A
 * behaviour case is `actual_behavior` against `expected_behavior`, so it is a
 * transition and renders as one; a maintenance goal is a sentence plus a finish
 * condition, so it is a statement with a detail line. Reaching for a sixth shape
 * whenever a section has one extra field is how twenty-six layouts happen.
 *
 * ## A fragment key is only unique inside its owner
 *
 * `AC-2` exists as many times as there are Streams with two acceptance criteria.
 * {@link SpecFragmentModel} therefore always carries `owner`, and nothing in the
 * UI is allowed to render `id` without it unless the owner is the page you are
 * already on. {@link fragmentAnchor} is the only form that is globally unique.
 *
 * ## Every read is a coercion
 *
 * The API types `document` as `Record<string, unknown>` on purpose — a document
 * written before a schema change has to stay readable rather than becoming a 422
 * on a page that only displays it. So a section may be absent, or present with
 * the wrong shape, and a non-string reaching JSX would take the whole page down
 * over one malformed field.
 */

/* ------------------------------------------------------------------ model -- */

/** A labelled prose line the fragment owns, as opposed to a pointer elsewhere. */
export interface SpecDetail {
  readonly label: string;
  readonly text: string;
}

export interface SpecWorkflowStep {
  readonly id: string;
  readonly action: string;
  readonly result: string | null;
}

export type SpecShape =
  | { readonly kind: "statement"; readonly text: string }
  | {
      readonly kind: "criterion";
      readonly given: string;
      readonly when: string;
      readonly then: string;
    }
  | { readonly kind: "condition"; readonly condition: string; readonly outcome: string }
  | {
      readonly kind: "transition";
      /** Reproduction steps, or the single trigger that starts the transition. */
      readonly preamble: { readonly label: string; readonly items: readonly string[] } | null;
      readonly from: string;
      readonly to: string;
    }
  | {
      readonly kind: "workflow";
      readonly actor: string | null;
      readonly preconditions: readonly string[];
      readonly steps: readonly SpecWorkflowStep[];
    };

/**
 * Properties of the statement itself, which ride at its right edge. A reference
 * to something else is a labelled row underneath instead, so Verifies and
 * Implemented by read as relations rather than as tags.
 */
export interface SpecMarks {
  /** MoSCoW, on a single requirement. Distinct from entity priority by design. */
  readonly priority: string | null;
  readonly severity: string | null;
  /** How this is verified — a method, never a claim that it has been. */
  readonly method: string | null;
  /** The quality dimension a non-functional requirement constrains. */
  readonly category: string | null;
  /** A Milestone exit criterion's own stored completion state. */
  readonly state: string | null;
}

/** How a claim was established, and which local Sources it cites. */
export interface SpecEvidence {
  readonly basis: string;
  readonly sourceIds: readonly string[];
}

export interface SpecFragmentModel {
  /** The entity that holds this fragment. Never dropped. */
  readonly owner: string;
  /** The local id: `FR-1`, `AC-2`. Unique only inside `owner`. */
  readonly id: string;
  readonly section: SectionId;
  readonly shape: SpecShape;
  readonly marks: SpecMarks;
  /** Requirement ids and Rule keys this fragment claims to check. */
  readonly verifies: readonly string[];
  readonly details: readonly SpecDetail[];
  readonly evidence: SpecEvidence | null;
}

/** The globally unique form of a fragment reference: `S-46#CHG-1`. */
export function fragmentAnchor(owner: string, id: string): string {
  return `${owner}#${id}`;
}

/* --------------------------------------------------------------- sections -- */

/**
 * Every addressable section, with the human label and the shape it renders in.
 *
 * `scope.included` and `scope.excluded` both mint `SCP-*` ids, so the section —
 * not the id prefix — is what identifies where a fragment came from.
 */
export const SECTION_IDS = [
  "scope_included",
  "scope_excluded",
  "discovery_included",
  "discovery_excluded",
  "outcomes",
  "success_metrics",
  "functional",
  "non_functional",
  "acceptance_criteria",
  "workflows",
  "edge_cases",
  "behavior_cases",
  "changes",
  "refactor_targets",
  "hypotheses",
  "research_questions",
  "investigation_questions",
  "success_criteria",
  "decision_rules",
  "invariants",
  "quality_goals",
  "maintenance_goals",
  "risks",
  "exit_criteria",
  "open_questions",
  "assumptions",
] as const;

export type SectionId = (typeof SECTION_IDS)[number];

/**
 * The order sections read in: what the entity covers, then what it must do, then
 * how that is checked, then what is unresolved.
 *
 * Open questions and assumptions come last everywhere. They frame the document
 * rather than specifying it, and a reader who meets them first reads the whole
 * thing as provisional.
 */
export const SECTION_ORDER: readonly SectionId[] = [
  "scope_included",
  "scope_excluded",
  "discovery_included",
  "discovery_excluded",
  "outcomes",
  "success_metrics",
  "functional",
  "non_functional",
  "acceptance_criteria",
  "behavior_cases",
  "changes",
  "refactor_targets",
  "invariants",
  "hypotheses",
  "research_questions",
  "investigation_questions",
  "success_criteria",
  "decision_rules",
  "quality_goals",
  "maintenance_goals",
  "workflows",
  "edge_cases",
  "risks",
  "exit_criteria",
  "open_questions",
  "assumptions",
];

/**
 * Which `implements` field on a Task points at which section.
 *
 * A Task references business work by typed namespace, and the namespace is what
 * makes the reference checkable: `requirement_ids` may only hold `FR-*` or
 * `NFR-*`. Both map to the same two requirement sections, which is why this is a
 * list of sections rather than one.
 */
export const IMPLEMENTS_FIELD_SECTIONS = {
  requirement_ids: ["functional", "non_functional"],
  acceptance_criteria_ids: ["acceptance_criteria"],
  behavior_case_ids: ["behavior_cases"],
  change_ids: ["changes"],
  hypothesis_ids: ["hypotheses"],
  research_question_ids: ["research_questions"],
  success_criteria_ids: ["success_criteria"],
  decision_rule_ids: ["decision_rules"],
  investigation_question_ids: ["investigation_questions"],
  refactor_target_ids: ["refactor_targets"],
  invariant_ids: ["invariants"],
  quality_goal_ids: ["quality_goals"],
  maintenance_goal_ids: ["maintenance_goals"],
} as const satisfies Record<string, readonly SectionId[]>;

/**
 * The sections a Task's `implements` edge can actually point at.
 *
 * This is the whole list, derived from the fields above rather than written twice.
 * It matters because an "Implemented by" row on a section outside it would claim an
 * edge the schema cannot express: there is no `scope_ids` on a Task, so an empty
 * row under a scope item would read as work nobody has picked up when in fact no
 * Task could ever reference it. Empty cells that mean "impossible" are exactly the
 * cells that get read as "missing".
 */
export const TARGETABLE_SECTIONS: ReadonlySet<SectionId> = new Set(
  Object.values(IMPLEMENTS_FIELD_SECTIONS).flat(),
);

export function isTargetable(section: SectionId): boolean {
  return TARGETABLE_SECTIONS.has(section);
}

/* ---------------------------------------------------------------- readers -- */

const NO_MARKS: SpecMarks = {
  priority: null,
  severity: null,
  method: null,
  category: null,
  state: null,
};

function readEvidence(item: JsonObject): SpecEvidence | null {
  const evidence = asRecord(item.evidence);
  const basis = optionalText(evidence.basis);
  if (basis === null) return null;
  return { basis, sourceIds: asTextArray(evidence.source_ids) };
}

function detail(label: string, value: unknown): readonly SpecDetail[] {
  const text = optionalText(value);
  return text === null ? [] : [{ label, text }];
}

/** `p95_latency <= 200 ms`, assembled from the four fields that make it checkable. */
function measurement(item: JsonObject): string {
  const metric = asText(item.metric);
  const operator = asText(item.operator);
  const target = asNumber(item.target);
  const unit = asText(item.unit);
  const comparison =
    operator.length > 0 && target !== null ? `${operator} ${String(target)} ${unit}`.trim() : "";
  return [metric, comparison].filter((part) => part.length > 0).join(" ");
}

type ItemReader = (item: JsonObject) => Omit<SpecFragmentModel, "owner" | "id" | "section">;

const statementOf = (
  text: string,
  item: JsonObject,
  extra: {
    readonly marks?: Partial<SpecMarks>;
    readonly details?: readonly SpecDetail[];
    readonly verifies?: readonly string[];
  } = {},
) => ({
  shape: { kind: "statement", text } as const,
  marks: { ...NO_MARKS, ...extra.marks },
  details: extra.details ?? [],
  verifies: extra.verifies ?? [],
  evidence: readEvidence(item),
});

/**
 * One reader per section. Each one names the fields it reads, so a section that
 * gains a field shows up here as a decision rather than as silence.
 */
const READERS: Record<SectionId, ItemReader> = {
  scope_included: (item) => statementOf(asText(item.statement), item),
  scope_excluded: (item) => statementOf(asText(item.statement), item),
  discovery_included: (item) => statementOf(asText(item.statement), item),
  discovery_excluded: (item) => statementOf(asText(item.statement), item),

  outcomes: (item) =>
    statementOf(asText(item.outcome), item, { details: detail("Indicator", item.indicator) }),

  success_metrics: (item) => {
    const baseline = asNumber(item.baseline);
    return statementOf(measurement(item), item, {
      details: baseline === null ? [] : [{ label: "Baseline", text: String(baseline) }],
    });
  },

  functional: (item) =>
    statementOf(asText(item.statement), item, {
      marks: { priority: optionalText(item.priority) },
    }),

  non_functional: (item) =>
    statementOf(measurement(item), item, {
      marks: { category: optionalText(item.category) },
    }),

  acceptance_criteria: (item) => {
    const verifies = asRecord(item.verifies);
    return {
      shape: {
        kind: "criterion",
        given: asText(item.given),
        when: asText(item.when),
        // `then` is the domain's given/when/then vocabulary and part of the wire
        // format, so it is not renameable. The lint rule guards against an object
        // being accidentally awaited; this one is a plain data shape that nothing
        // awaits, and its `then` is a string rather than a callable.
        // oxlint-disable-next-line unicorn/no-thenable
        then: asText(item.then),
      },
      marks: { ...NO_MARKS, method: optionalText(item.verification) },
      details: [],
      // Requirement ids and Rule keys share one row: both are things this
      // criterion claims to check, and splitting them would imply the criterion
      // treats them differently. It does not.
      verifies: [...asTextArray(verifies.requirement_ids), ...asTextArray(verifies.rule_keys)],
      evidence: readEvidence(item),
    };
  },

  workflows: (item) => ({
    shape: {
      kind: "workflow",
      actor: optionalText(item.actor),
      preconditions: asTextArray(item.preconditions),
      steps: asArray<JsonObject>(item.steps).map((step) => ({
        id: asText(step.id),
        action: asText(step.action),
        result: optionalText(step.result),
      })),
    },
    marks: NO_MARKS,
    details: [],
    verifies: [],
    evidence: readEvidence(item),
  }),

  edge_cases: (item) => ({
    // `scenario` narrows the trigger when it is present; the trigger alone is the
    // condition otherwise.
    shape: {
      kind: "condition",
      condition: [asText(item.trigger), optionalText(item.scenario)]
        .filter((part): part is string => part !== null && part.length > 0)
        .join(" — "),
      outcome: asText(item.expected_behavior),
    },
    marks: { ...NO_MARKS, severity: optionalText(item.severity) },
    details: [],
    verifies: [],
    evidence: readEvidence(item),
  }),

  decision_rules: (item) => ({
    shape: {
      kind: "condition",
      condition: asText(item.condition),
      outcome: asText(item.decision),
    },
    marks: NO_MARKS,
    details: [],
    verifies: [],
    evidence: readEvidence(item),
  }),

  behavior_cases: (item) => ({
    shape: {
      kind: "transition",
      preamble: (() => {
        const steps = asTextArray(item.reproduction);
        return steps.length > 0 ? { label: "Reproduction", items: steps } : null;
      })(),
      from: asText(item.actual_behavior),
      to: asText(item.expected_behavior),
    },
    marks: { ...NO_MARKS, severity: optionalText(item.severity) },
    details: [],
    verifies: [],
    evidence: readEvidence(item),
  }),

  changes: (item) => ({
    shape: {
      kind: "transition",
      preamble: (() => {
        const trigger = optionalText(item.trigger);
        return trigger === null ? null : { label: "Trigger", items: [trigger] };
      })(),
      from: asText(item.current_state),
      to: asText(item.desired_state),
    },
    marks: NO_MARKS,
    details: detail("Success measure", item.success_measure),
    verifies: [],
    evidence: readEvidence(item),
  }),

  refactor_targets: (item) => ({
    shape: {
      kind: "transition",
      preamble: null,
      from: asText(item.current_state),
      to: asText(item.target_state),
    },
    marks: NO_MARKS,
    details: [],
    verifies: [],
    evidence: readEvidence(item),
  }),

  hypotheses: (item) => statementOf(asText(item.hypothesis), item),

  research_questions: (item) =>
    statementOf(asText(item.question), item, {
      details: detail("Why it matters", item.why_it_matters),
    }),

  investigation_questions: (item) =>
    statementOf(asText(item.question), item, {
      details: detail("Why it matters", item.why_it_matters),
    }),

  success_criteria: (item) =>
    statementOf(asText(item.criterion), item, {
      details: detail("Measurement", item.measurement),
    }),

  invariants: (item) => statementOf(asText(item.statement), item),

  quality_goals: (item) =>
    statementOf(asText(item.goal), item, { details: detail("Measurement", item.measurement) }),

  maintenance_goals: (item) =>
    statementOf(asText(item.goal), item, { details: detail("Done when", item.done_when) }),

  risks: (item) =>
    statementOf(asText(item.risk), item, {
      marks: { severity: optionalText(item.severity) },
      details: detail("Mitigation", item.mitigation),
    }),

  exit_criteria: (item) =>
    statementOf(asText(item.criterion), item, {
      marks: { state: optionalText(item.status) },
      details: detail("Waiver reason", item.waiver_reason),
    }),

  open_questions: (item) => statementOf(asText(item.question), item),

  assumptions: (item) => statementOf(asText(item.statement), item),
};

/** Where in `content` each section's array lives. */
const SECTION_PATHS: Record<SectionId, readonly string[]> = {
  scope_included: ["scope", "included"],
  scope_excluded: ["scope", "excluded"],
  discovery_included: ["discovery_scope", "included"],
  discovery_excluded: ["discovery_scope", "excluded"],
  outcomes: ["outcomes"],
  success_metrics: ["success_metrics"],
  functional: ["requirements", "functional"],
  non_functional: ["requirements", "non_functional"],
  acceptance_criteria: ["acceptance_criteria"],
  workflows: ["workflows"],
  edge_cases: ["edge_cases"],
  behavior_cases: ["behavior_cases"],
  changes: ["changes"],
  refactor_targets: ["refactor_targets"],
  hypotheses: ["hypotheses"],
  research_questions: ["research_questions"],
  investigation_questions: ["questions"],
  success_criteria: ["success_criteria"],
  decision_rules: ["decision_rules"],
  invariants: ["invariants"],
  quality_goals: ["quality_goals"],
  maintenance_goals: ["maintenance_goals"],
  risks: ["risks"],
  exit_criteria: ["exit_criteria"],
  open_questions: ["open_questions"],
  assumptions: ["assumptions"],
};

function itemsAt(content: JsonObject, path: readonly string[]): JsonObject[] {
  let cursor: unknown = content;
  for (const segment of path) {
    cursor = asRecord(cursor)[segment];
  }
  return asArray<JsonObject>(cursor);
}

/**
 * Every addressable fragment of one document, in reading order.
 *
 * An item without an `id` is dropped rather than given a positional one: a
 * fragment with no local id cannot be referenced, linked to or copied, and
 * minting `AC-3` for it would make the anchor a lie the moment the document is
 * rewritten.
 */
export function readFragments(
  owner: string,
  document: Record<string, unknown>,
): readonly SpecFragmentModel[] {
  const content = contentOf(document);
  return SECTION_ORDER.flatMap((section) =>
    itemsAt(content, SECTION_PATHS[section]).flatMap((item) => {
      const id = asText(item.id);
      if (id.length === 0) return [];
      return [{ owner, id, section, ...READERS[section](item) }];
    }),
  );
}

/** One searchable line of a fragment, assembled exactly as the UI reads it. */
export function fragmentText(fragment: SpecFragmentModel): string {
  const { shape } = fragment;
  switch (shape.kind) {
    case "statement":
      return shape.text;
    case "criterion":
      return `Given ${shape.given} · When ${shape.when} · Then ${shape.then}`;
    case "condition":
      return `${shape.condition} → ${shape.outcome}`;
    case "transition":
      return `${shape.from} → ${shape.to}`;
    case "workflow":
      return shape.steps.map((step) => step.action).join(" · ");
  }
}

/** Groups fragments by section, keeping {@link SECTION_ORDER} and dropping empties. */
export function groupFragments(
  fragments: readonly SpecFragmentModel[],
): readonly { readonly section: SectionId; readonly items: readonly SpecFragmentModel[] }[] {
  return SECTION_ORDER.flatMap((section) => {
    const items = fragments.filter((fragment) => fragment.section === section);
    return items.length === 0 ? [] : [{ section, items }];
  });
}

/* -------------------------------------------------------- rule application -- */

/**
 * A local use of one canonical project Rule. The application may narrow when the
 * Rule applies; it never overrides the Rule's own text, which lives on the `R-*`
 * entity.
 */
export interface RuleApplicationModel {
  readonly id: string;
  readonly ruleKey: string;
  readonly appliesWhen: string | null;
  readonly application: string | null;
}

export function readRuleApplications(
  document: Record<string, unknown>,
): readonly RuleApplicationModel[] {
  return asArray<JsonObject>(contentOf(document).rule_applications).flatMap((item) => {
    const ruleKey = asText(item.rule_key);
    if (ruleKey.length === 0) return [];
    return [
      {
        id: asText(item.id),
        ruleKey,
        appliesWhen: optionalText(item.applies_when),
        application: optionalText(item.application),
      },
    ];
  });
}

/* ------------------------------------------------------------------ sources -- */

/**
 * One immutable observation that claim evidence cites by local id.
 *
 * `supersededBy` is the whole freshness model. A Source becomes stale by being
 * explicitly replaced and by nothing else — there is no age column anywhere in
 * this app, because "observed four months ago" says nothing about whether the
 * observation still holds, and dressing elapsed time up as staleness invents a
 * fact nobody measured.
 */
export interface SourceModel {
  readonly id: string;
  readonly type: string;
  readonly reference: string;
  readonly snapshot: string | null;
  readonly supersedes: readonly string[];
  readonly supersededBy: readonly string[];
}

export function readSources(document: Record<string, unknown>): readonly SourceModel[] {
  const raw = asArray<JsonObject>(asRecord(document.provenance).sources).flatMap((item) => {
    const id = asText(item.id);
    if (id.length === 0) return [];
    return [
      {
        id,
        type: asText(item.type),
        reference: asText(item.reference),
        snapshot: optionalText(item.snapshot),
        supersedes: asTextArray(item.supersedes_source_ids),
      },
    ];
  });

  // The stored direction is "this Source replaces those"; a reader wants the
  // reverse — "has this one been replaced". Inverted once, here, rather than by
  // every consumer.
  const supersededBy = new Map<string, string[]>();
  for (const source of raw) {
    for (const replaced of source.supersedes) {
      const bucket = supersededBy.get(replaced);
      if (bucket) bucket.push(source.id);
      else supersededBy.set(replaced, [source.id]);
    }
  }

  return raw.map((source) => ({ ...source, supersededBy: supersededBy.get(source.id) ?? [] }));
}
