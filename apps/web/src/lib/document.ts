/**
 * Reading the entity `document`, which arrives untyped.
 *
 * The aggregate types every `document` as `Record<string, unknown>` on purpose:
 * the endpoint is a window, and a document written before a schema change has to
 * stay readable rather than becoming a 422 on a page that only displays it.
 *
 * So every read here is a coercion, not a cast. A section may be absent, or
 * present with the wrong shape, and the failure mode matters: a non-string
 * reaching JSX crashes React with "Objects are not valid as a React child",
 * which would take the whole drawer down over one malformed field.
 */

/** Any value `JSON.parse` can produce. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** A JSON object — what a `document` and each of its sections actually is. */
export type JsonObject = { [key: string]: JsonValue };

/**
 * Restates a type with every `unknown` leaf as {@link JsonValue}.
 *
 * The API types `document` as `Record<string, unknown>`, and TanStack Start
 * refuses to return `unknown` from a server function — correctly, since it
 * cannot know that an arbitrary `unknown` survives serialisation. But this value
 * came out of `JSON.parse`, so it demonstrably can.
 *
 * Applied mechanically rather than by hand-writing the aggregate's types, which
 * keeps η's Eden guarantee intact: a field the server renames or drops is still
 * a type error in the components that read it.
 */
export type Jsonified<T> = unknown extends T
  ? JsonValue
  : T extends (infer Element)[]
    ? Jsonified<Element>[]
    : T extends object
      ? { [Key in keyof T]: Jsonified<T[Key]> }
      : T;

/** A JSON object, or `{}` for anything that is not one. Arrays are not objects here. */
export function asRecord(value: unknown): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

/**
 * A JSON array, or `[]`.
 *
 * The element type is the caller's claim, unchecked — every consumer treats
 * elements as all-optional shapes for exactly that reason.
 */
export function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/** A string, or `""`. The guard that keeps a malformed field from reaching JSX. */
export function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** A finite number, or `null` — so `0` survives and `NaN` does not. */
export function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * The document envelope's `content` section (domain spec §5), which is where
 * every section the drawer renders lives. `meta`, `links` and `provenance` are
 * siblings of it, not part of it.
 */
export function contentOf(document: JsonObject): JsonObject {
  return asRecord(document.content);
}

/** Renders an arbitrary JSON value as one compact line, for free-key maps. */
export function jsonToText(value: unknown): string {
  if (Array.isArray(value)) return value.map(jsonToText).join(", ");
  if (typeof value === "object" && value !== null) {
    return Object.entries(value)
      .map(([key, nested]) => `${key}: ${jsonToText(nested)}`)
      .join("; ");
  }
  return String(value);
}

/* ------------------------------------------------------------ section shapes
 *
 * Mirrors of the API's document schemas with every field optional, because
 * nothing validated this payload on the way out. They exist so the components
 * read named fields instead of indexing `unknown`; they are not a promise that
 * the field is there.
 */

/** One `included` / `excluded` scope line. */
export interface ScopeItem {
  id?: string;
  statement?: string;
}

export interface Scope {
  included?: ScopeItem[];
  excluded?: ScopeItem[];
}

/** A local use of one canonical project Rule. Rule text lives on the `R-*` entity. */
export interface RuleApplication {
  id?: string;
  rule_key?: string;
  applies_when?: string;
  application?: string;
}

export interface WorkflowStep {
  id?: string;
  action?: string;
  result?: string;
}

export interface Workflow {
  id?: string;
  workflow_name?: string;
  actor?: string;
  preconditions?: string[];
  steps?: WorkflowStep[];
}

export interface EdgeCase {
  id?: string;
  trigger?: string;
  scenario?: string;
  expected_behavior?: string;
  severity?: string;
}

/** A given/when/then criterion. `verifies` points at the requirement ids it covers. */
export interface AcceptanceCriterion {
  id?: string;
  type?: string;
  given?: string;
  when?: string;
  then?: string;
  verifies?: {
    requirement_ids?: string[];
    rule_keys?: string[];
  };
  verification?: string;
}

export interface FunctionalRequirement {
  id?: string;
  statement?: string;
  priority?: string;
}

/** A quality constraint stated as a measurement rather than an adjective. */
export interface NonFunctionalRequirement {
  id?: string;
  category?: string;
  metric?: string;
  operator?: string;
  target?: number;
  unit?: string;
}

export interface Requirements {
  functional?: FunctionalRequirement[];
  non_functional?: NonFunctionalRequirement[];
}

/** Who the stream is for. `primary` is the one actor whose need it exists to serve. */
export interface StreamActor {
  primary?: string;
  secondary?: string[];
}

/** What the stream delivers on its own — the "is this shippable by itself?" section. */
export interface VerticalSlice {
  delivers_alone?: string;
  needs_no_other_stream?: boolean;
  prerequisites?: string[];
}

/** One thing an `investigation` stream has to answer. */
export interface InvestigationQuestion {
  id?: string;
  question?: string;
  why_it_matters?: string;
}

/** A measurable finish line for an investigation, in place of acceptance criteria. */
export interface SuccessCriterion {
  id?: string;
  criterion?: string;
  measurement?: string;
}

export interface BehaviorCase {
  id?: string;
  reproduction?: string[];
  actual_behavior?: string;
  expected_behavior?: string;
  severity?: string;
}

export interface ChangeTarget {
  id?: string;
  trigger?: string;
  current_state?: string;
  desired_state?: string;
  success_measure?: string;
}

export interface ExperimentHypothesis {
  id?: string;
  hypothesis?: string;
}

export interface ResearchQuestion {
  id?: string;
  question?: string;
  why_it_matters?: string;
}

export interface DecisionRule {
  id?: string;
  condition?: string;
  decision?: string;
}

export interface RefactorTarget {
  id?: string;
  current_state?: string;
  target_state?: string;
}

export interface RefactorInvariant {
  id?: string;
  statement?: string;
}

export interface QualityGoal {
  id?: string;
  goal?: string;
  measurement?: string;
}

export interface MaintenanceGoal {
  id?: string;
  goal?: string;
  done_when?: string;
}

export interface MaintenanceRisk {
  id?: string;
  risk?: string;
  mitigation?: string;
  severity?: string;
}

export interface ClaimEvidence {
  basis?: string;
  source_ids?: string[];
}

export interface OpenQuestion {
  id?: string;
  question?: string;
}

export interface Assumption {
  id?: string;
  statement?: string;
  source_ids?: string[];
}

export interface MilestoneExitCriterion {
  id?: string;
  criterion?: string;
  status?: string;
  waiver_reason?: string;
  evidence?: ClaimEvidence;
}

export interface TechnicalDecision {
  decision?: string;
  reason?: string;
  alternatives_considered?: string[];
}

export interface TaskVerification {
  id?: string;
  type?: string;
  procedure?: string;
  expected?: string;
}
