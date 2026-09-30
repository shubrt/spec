import type { WorkspaceScope } from "../auth/workspaceScope";
import { parseVersionedKey } from "../keys";
import type { DbExecutor } from "../repository/entity";
import { type RuleRevisionPin, ruleRepository } from "../repository/rule";
import { type SpecDocument, parseDocument } from "../schema/document";
import {
  deriveSourceFreshness,
  relevantSources,
  type SourceFreshness,
} from "../schema/sourceFreshness";

type ParsedRule = Extract<SpecDocument, { entity: "rule" }>;

type ContextEvidence = {
  readonly basis: "stated" | "verified" | "inferred" | "assumed";
  readonly source_ids?: readonly string[];
};

export type ContextRuleUse = {
  readonly ruleKey: string;
  readonly source:
    | "epic_application"
    | "stream_application"
    | "task_constraint"
    | "acceptance_criterion"
    | "task_pin";
  readonly ownerKey: string;
  readonly localId: string | null;
  readonly appliesWhen: string | null;
  readonly application: string | null;
  readonly evidence: ContextEvidence | null;
  readonly inherited: boolean;
};

export type CanonicalRuleDefinition = {
  readonly key: string;
  readonly title: string;
  readonly status: string;
  readonly revision: number;
  /** `task_pin` is the exact historical revision; `current` is the present Rule row. */
  readonly revisionSource: "task_pin" | "current";
  readonly content: ParsedRule["content"] | null;
  readonly sources: readonly (NonNullable<ParsedRule["provenance"]["sources"]>[number] & {
    readonly freshness: SourceFreshness;
  })[];
};

export type ResolvedContextRules = {
  readonly definitions: readonly CanonicalRuleDefinition[];
  readonly uses: readonly ContextRuleUse[];
  readonly unresolvedKeys: readonly string[];
  /** Effective terminal Rule keys for which the Task recorded no revision pin. */
  readonly unpinnedHistoricalKeys: readonly string[];
  readonly unresolvedPinnedRevisions: readonly RuleRevisionPin[];
};

type RuleApplicationLike = {
  readonly id: string;
  readonly rule_key: string;
  readonly applies_when?: string;
  readonly application?: string;
  readonly evidence?: ContextEvidence;
};

type AcceptanceCriterionLike = {
  readonly id: string;
  readonly verifies?: { readonly rule_keys?: readonly string[] };
  readonly evidence?: ContextEvidence;
};

export const applicationRuleUses = (
  applications: readonly RuleApplicationLike[],
  owner: { readonly entity: "epic" | "stream"; readonly key: string },
  inherited: boolean,
): ContextRuleUse[] =>
  applications.map((application) => ({
    ruleKey: application.rule_key,
    source: owner.entity === "epic" ? "epic_application" : "stream_application",
    ownerKey: owner.key,
    localId: application.id,
    appliesWhen: application.applies_when ?? null,
    application: application.application ?? null,
    evidence: application.evidence ?? null,
    inherited,
  }));

export const acceptanceCriterionRuleUses = (
  criteria: readonly AcceptanceCriterionLike[],
  ownerKey: string,
  inherited: boolean,
): ContextRuleUse[] =>
  criteria.flatMap((criterion) =>
    (criterion.verifies?.rule_keys ?? []).map((ruleKey) => ({
      ruleKey,
      source: "acceptance_criterion" as const,
      ownerKey,
      localId: criterion.id,
      appliesWhen: null,
      application: null,
      evidence: criterion.evidence ?? null,
      inherited,
    })),
  );

export const taskConstraintRuleUses = (
  ruleKeys: readonly string[],
  taskKey: string,
): ContextRuleUse[] =>
  ruleKeys.map((ruleKey) => ({
    ruleKey,
    source: "task_constraint",
    ownerKey: taskKey,
    localId: null,
    appliesWhen: null,
    application: null,
    evidence: null,
    inherited: false,
  }));

export const taskPinRuleUses = (
  pins: readonly RuleRevisionPin[],
  taskKey: string,
): ContextRuleUse[] =>
  pins.map((pin) => ({
    ruleKey: pin.key,
    source: "task_pin",
    ownerKey: taskKey,
    localId: null,
    appliesWhen: null,
    application: null,
    evidence: null,
    inherited: false,
  }));

const storedRule = (document: Record<string, unknown>): ParsedRule | null => {
  const result = parseDocument(document, { source: "store" });
  return result.ok && result.document.entity === "rule" ? result.document : null;
};

const uniqueUses = (uses: readonly ContextRuleUse[]): ContextRuleUse[] => {
  const found = new Map<string, ContextRuleUse>();
  for (const use of uses) {
    const identity = JSON.stringify(use);
    if (!found.has(identity)) found.set(identity, use);
  }
  return [...found.values()];
};

const sequenceOf = (key: string): number =>
  parseVersionedKey(key)?.sequence ?? Number.MAX_SAFE_INTEGER;

/** Resolves any number of Rule keys and terminal pins in at most two batch reads. */
export async function resolveContextRules(
  scope: WorkspaceScope,
  input: {
    readonly projectId: string;
    readonly uses: readonly ContextRuleUse[];
    readonly pins?: readonly RuleRevisionPin[];
    /** Terminal context must never fill a missing historical pin from current state. */
    readonly requirePins?: boolean;
  },
  executor?: DbExecutor,
): Promise<ResolvedContextRules> {
  const uses = uniqueUses(input.uses);
  const pinByKey = new Map((input.pins ?? []).map((pin) => [pin.key, pin]));
  const allKeys = [...new Set([...uses.map((use) => use.ruleKey), ...pinByKey.keys()])];
  const unpinnedHistoricalKeys = input.requirePins
    ? allKeys.filter((key) => !pinByKey.has(key))
    : [];
  const unpinned = new Set(unpinnedHistoricalKeys);
  const keys = allKeys.filter((key) => !unpinned.has(key));
  if (keys.length === 0) {
    return {
      definitions: [],
      uses,
      unresolvedKeys: [],
      unpinnedHistoricalKeys,
      unresolvedPinnedRevisions: [],
    };
  }

  const pins = [...pinByKey.values()];
  const currentRows = await ruleRepository.listByKeys(
    scope,
    { projectId: input.projectId, keys },
    executor,
  );
  const currentByKey = new Map(currentRows.map((row) => [row.key, row]));
  const snapshots = await ruleRepository.listRevisionSnapshots(
    scope,
    {
      projectId: input.projectId,
      targets: pins.flatMap((pin) => {
        const current = currentByKey.get(pin.key);
        return current === undefined ? [] : [{ ...pin, entityId: current.id }];
      }),
    },
    executor,
  );
  const snapshotByKey = new Map(snapshots.map((snapshot) => [snapshot.key, snapshot]));
  const definitions: CanonicalRuleDefinition[] = [];
  const unresolvedKeys: string[] = [];

  for (const key of keys) {
    const pin = pinByKey.get(key);
    const snapshot = snapshotByKey.get(key);
    const current = currentByKey.get(key);
    if (pin !== undefined && snapshot === undefined) {
      // A historical promise must never be silently replaced by today's Rule.
      // `unresolvedPinnedRevisions` below is the actionable result.
      continue;
    }
    const selected = pin === undefined ? current?.document : snapshot?.document;
    if (selected === undefined) {
      unresolvedKeys.push(key);
      continue;
    }
    const parsed = storedRule(selected);
    const sources = parsed?.provenance.sources ?? [];
    const projectedSources = relevantSources(sources, parsed?.content);
    const freshness = deriveSourceFreshness(sources);
    const isPinned = pin !== undefined;
    definitions.push({
      key,
      // A malformed historical snapshot must not borrow today's relational
      // metadata and thereby look current. Its own revision remains explicit.
      title: parsed?.meta.title ?? (isPinned ? key : (current?.title ?? key)),
      status: parsed?.meta.status ?? (isPinned ? "unknown" : (current?.status ?? "unknown")),
      revision: isPinned ? (snapshot?.revision ?? 0) : (current?.revision ?? 0),
      revisionSource: isPinned ? "task_pin" : "current",
      content: parsed?.content ?? null,
      sources: projectedSources.map((source) => ({
        ...source,
        freshness: freshness.get(source.id) ?? "unknown",
      })),
    });
  }

  definitions.sort((left, right) => sequenceOf(left.key) - sequenceOf(right.key));
  const unresolvedPinnedRevisions = pins.filter((pin) => !snapshotByKey.has(pin.key));
  return {
    definitions,
    uses,
    unresolvedKeys,
    unpinnedHistoricalKeys,
    unresolvedPinnedRevisions,
  };
}
