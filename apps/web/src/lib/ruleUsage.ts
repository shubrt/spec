import { asArray, asNumber, asRecord, asText, contentOf } from "~/lib/document";
import type { EpicNode } from "~/server/board";

export interface RuleUse {
  readonly kind: "epic" | "stream" | "task";
  readonly key: string;
  readonly title: string;
  readonly relation: "application" | "criterion" | "constraint" | "revision_pin";
  readonly localId: string | null;
  readonly pinnedRevision: number | null;
}

/** Indexes every structured Rule use in one pass over the loaded ownership tree. */
export function indexRuleUses(epics: readonly EpicNode[]): ReadonlyMap<string, readonly RuleUse[]> {
  const indexed = new Map<string, RuleUse[]>();

  for (const epic of epics) {
    collectApplications(indexed, epic, "epic", contentOf(epic.document));

    for (const stream of epic.streams) {
      const streamContent = contentOf(stream.document);
      collectApplications(indexed, stream, "stream", streamContent);

      for (const rawCriterion of asArray(streamContent.acceptance_criteria)) {
        const criterion = asRecord(rawCriterion);
        const verifies = asRecord(criterion.verifies);
        for (const rawRuleKey of asArray(verifies.rule_keys)) {
          append(indexed, asText(rawRuleKey), {
            kind: "stream",
            key: stream.key,
            title: stream.title,
            relation: "criterion",
            localId: asText(criterion.id) || null,
            pinnedRevision: null,
          });
        }
      }

      for (const task of stream.tasks) {
        const taskContent = contentOf(task.document);
        for (const rawRuleKey of asArray(taskContent.constrained_by_rule_keys)) {
          append(indexed, asText(rawRuleKey), {
            kind: "task",
            key: task.key,
            title: task.title,
            relation: "constraint",
            localId: null,
            pinnedRevision: null,
          });
        }

        const execution = asRecord(task.document.execution);
        for (const rawPin of asArray(execution.rule_revisions_used)) {
          const pin = asRecord(rawPin);
          append(indexed, asText(pin.rule_key), {
            kind: "task",
            key: task.key,
            title: task.title,
            relation: "revision_pin",
            localId: null,
            pinnedRevision: asNumber(pin.revision),
          });
        }
      }
    }
  }

  return indexed;
}

/** One Rule lookup for detail views; the catalogue uses the index directly. */
export function usesOfRule(epics: readonly EpicNode[], ruleKey: string): readonly RuleUse[] {
  return indexRuleUses(epics).get(ruleKey) ?? [];
}

export function ruleConsumerCount(uses: readonly RuleUse[]): number {
  return new Set(uses.map((use) => `${use.kind}:${use.key}`)).size;
}

function collectApplications(
  into: Map<string, RuleUse[]>,
  entity: { readonly key: string; readonly title: string },
  kind: "epic" | "stream",
  content: ReturnType<typeof contentOf>,
) {
  for (const rawApplication of asArray(content.rule_applications)) {
    const application = asRecord(rawApplication);
    append(into, asText(application.rule_key), {
      kind,
      key: entity.key,
      title: entity.title,
      relation: "application",
      localId: asText(application.id) || null,
      pinnedRevision: null,
    });
  }
}

function append(index: Map<string, RuleUse[]>, ruleKey: string, use: RuleUse) {
  if (!ruleKey) return;
  const bucket = index.get(ruleKey);
  if (bucket) bucket.push(use);
  else index.set(ruleKey, [use]);
}
