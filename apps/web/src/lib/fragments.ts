import type { SectionId, SpecFragmentModel } from "@zpecs/api/read";

/**
 * The presentation half of a specification fragment.
 *
 * Extraction moved to `libs/api/src/domain/service/specFragment.ts`: turning a
 * stored document into addressable fragments is a projection of the document, not a
 * decision about how it is drawn, and keeping it server-side is what lets a fragment
 * be paged, counted and searched without shipping every document to the browser.
 *
 * What stays here is the part that genuinely is presentation — the human label for
 * each section — plus two pure helpers the renderers use. The API owns the section
 * *ids*, their shapes and where they live in the document; this file owns only what
 * they are called in English.
 *
 * The split is deliberate rather than incidental. If the two ever disagree it can
 * only be about a label, and {@link sectionLabel} degrades to a computed one rather
 * than breaking — a section the API gains before this file names it still reads.
 */

export type { SectionId, SpecFragmentModel, SpecShape, SpecMarks } from "@zpecs/api/read";

/**
 * Section labels, and the order sections read in.
 *
 * What the entity covers, then what it must do, then how that is checked, then what
 * is unresolved. Open questions and assumptions come last everywhere: they frame the
 * document rather than specify it, and a reader who meets them first reads the whole
 * thing as provisional.
 */
const SECTION_LABEL: Readonly<Record<SectionId, string>> = {
  scope_included: "In scope",
  scope_excluded: "Out of scope",
  discovery_included: "Discovery scope",
  discovery_excluded: "Outside discovery scope",
  outcomes: "Outcomes",
  success_metrics: "Success metrics",
  functional: "Functional requirements",
  non_functional: "Non-functional requirements",
  acceptance_criteria: "Acceptance criteria",
  behavior_cases: "Behaviour cases",
  changes: "Change targets",
  refactor_targets: "Refactor targets",
  invariants: "Invariants",
  hypotheses: "Hypotheses",
  research_questions: "Research questions",
  investigation_questions: "Investigation questions",
  success_criteria: "Success criteria",
  decision_rules: "Decision rules",
  quality_goals: "Quality goals",
  maintenance_goals: "Maintenance goals",
  workflows: "Workflows",
  edge_cases: "Edge cases",
  risks: "Risks",
  exit_criteria: "Exit criteria",
  open_questions: "Open questions",
  assumptions: "Assumptions",
};

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
 * The human name of a section.
 *
 * Falls back to a computed label rather than an empty string, so a section the API
 * gains before this file names it still reads as words.
 */
export function sectionLabel(section: string): string {
  const known = SECTION_LABEL[section as SectionId];
  if (known) return known;
  const spaced = section.replaceAll("_", " ").replaceAll(".", " · ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** The globally unique form of a fragment reference: `S-46#CHG-1`. */
export function fragmentAnchor(owner: string, id: string): string {
  return `${owner}#${id}`;
}

/**
 * The sections a Task's `implements` edge can point at.
 *
 * Mirrored from the API's own list rather than derived, because the web needs it
 * synchronously to decide whether to draw an "Implemented by" row. It matters that
 * this is exact: a row on a section outside the list would report an absence that is
 * structurally impossible — a Task has no field that could name a scope item, so an
 * empty row under one reads as missing work rather than as an impossible edge.
 */
const TARGETABLE: ReadonlySet<string> = new Set<SectionId>([
  "functional",
  "non_functional",
  "acceptance_criteria",
  "behavior_cases",
  "changes",
  "hypotheses",
  "research_questions",
  "success_criteria",
  "decision_rules",
  "investigation_questions",
  "refactor_targets",
  "invariants",
  "quality_goals",
  "maintenance_goals",
]);

export function isTargetable(section: string): boolean {
  return TARGETABLE.has(section);
}

/** Groups fragments by section, keeping {@link SECTION_ORDER} and dropping empties. */
export function groupFragments<Fragment extends { readonly section: SectionId }>(
  fragments: readonly Fragment[],
): readonly { readonly section: SectionId; readonly items: readonly Fragment[] }[] {
  return SECTION_ORDER.flatMap((section) => {
    const items = fragments.filter((fragment) => fragment.section === section);
    return items.length === 0 ? [] : [{ section, items }];
  });
}

/** One line of a fragment, whatever shape it is in. Used by indexes and excerpts. */
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
