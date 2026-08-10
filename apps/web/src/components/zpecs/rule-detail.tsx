import { Link } from "@tanstack/react-router";
import {
  Field,
  Panel,
  PanelTitle,
  ProseSection,
  RuledBlock,
  Section,
} from "~/components/zpecs/document-sections";
import {
  EntityDetailHeader,
  EntityDetailSurfaceProvider,
  type EntityDetailSurface,
} from "~/components/zpecs/entity-detail-header";
import { EntityKey, StatusBadge, TypeTag } from "~/components/zpecs/tokens";
import {
  asArray,
  asRecord,
  asText,
  contentOf,
  type Assumption,
  type OpenQuestion,
} from "~/lib/document";
import { type RuleUse, usesOfRule } from "~/lib/ruleUsage";
import { label, ruleStatus } from "~/lib/vocabulary";
import type { EpicNode, RuleNode } from "~/server/board";

export function RuleDetail({
  rule,
  epics,
  surface,
  projectId,
}: {
  rule: RuleNode;
  epics: readonly EpicNode[];
  surface: EntityDetailSurface;
  projectId: string;
}) {
  const content = contentOf(rule.document);
  const evidence = asRecord(content.evidence);
  const questions = asArray<OpenQuestion>(content.open_questions);
  const assumptions = asArray<Assumption>(content.assumptions);
  const provenance = asRecord(rule.document.provenance);
  const sources = asArray(provenance.sources);
  const uses = usesOfRule(epics, rule.key);

  return (
    <EntityDetailSurfaceProvider surface={surface}>
      <EntityDetailHeader
        surface={surface}
        eyebrow={
          <>
            <span>Rule</span>
            <EntityKey>{rule.key}</EntityKey>
          </>
        }
        title={rule.title}
        metadata={
          <>
            <StatusBadge tone={ruleStatus.toneOf(rule.status)}>{label(rule.status)}</StatusBadge>
            <span className="text-xs text-muted-foreground">revision {rule.revision}</span>
          </>
        }
      />

      <div className="px-6 pb-10 pt-5">
        {rule.summary ? (
          <p className="mb-6 text-sm leading-relaxed text-secondary-foreground">{rule.summary}</p>
        ) : null}

        {asText(content.statement) ? (
          <Section title="Rule">
            <RuledBlock label={rule.key}>
              <p className="text-sm font-medium leading-relaxed text-secondary-foreground">
                {asText(content.statement)}
              </p>
            </RuledBlock>
          </Section>
        ) : null}

        <ProseSection title="Rationale" value={content.rationale} />
        <ProseSection title="Impact" value={content.impact} />
        <ProseSection title="Consequence" value={content.consequence} />

        {asText(evidence.basis) || asArray(evidence.source_ids).length > 0 ? (
          <Section title="Claim evidence">
            <Panel>
              {asText(evidence.basis) ? (
                <Field name="basis">{label(asText(evidence.basis))}</Field>
              ) : null}
              {asArray(evidence.source_ids).length > 0 ? (
                <Field name="sources">
                  {asArray(evidence.source_ids).map(asText).filter(Boolean).join(", ")}
                </Field>
              ) : null}
            </Panel>
          </Section>
        ) : null}

        {uses.length > 0 ? (
          <Section title={`Used in · ${String(uniqueConsumerCount(uses))}`}>
            {uses.map((use, index) => (
              <RuleUseLink
                key={`${use.kind}-${use.key}-${use.relation}-${use.localId ?? index}`}
                use={use}
                projectId={projectId}
              />
            ))}
          </Section>
        ) : null}

        {questions.length > 0 ? (
          <Section title="Open questions">
            {questions.map((question, index) => (
              <Panel key={question.id ?? index}>
                <PanelTitle id={asText(question.id)}>{asText(question.question)}</PanelTitle>
              </Panel>
            ))}
          </Section>
        ) : null}

        {assumptions.length > 0 ? (
          <Section title="Assumptions">
            {assumptions.map((assumption, index) => (
              <Panel key={assumption.id ?? index}>
                <PanelTitle id={asText(assumption.id)}>{asText(assumption.statement)}</PanelTitle>
                {asArray(assumption.source_ids).length > 0 ? (
                  <div className="text-xs text-muted-foreground">
                    Sources: {asArray(assumption.source_ids).map(asText).filter(Boolean).join(", ")}
                  </div>
                ) : null}
              </Panel>
            ))}
          </Section>
        ) : null}

        {sources.length > 0 ? (
          <Section title="Sources">
            {sources.map((rawSource, index) => {
              const source = asRecord(rawSource);
              return (
                <Panel key={asText(source.id) || index}>
                  <PanelTitle id={asText(source.id)}>{asText(source.reference)}</PanelTitle>
                  <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                    {asText(source.type) ? <TypeTag>{label(asText(source.type))}</TypeTag> : null}
                    {asText(source.snapshot) ? (
                      <span>snapshot {asText(source.snapshot)}</span>
                    ) : null}
                  </div>
                </Panel>
              );
            })}
          </Section>
        ) : null}
      </div>
    </EntityDetailSurfaceProvider>
  );
}

function uniqueConsumerCount(uses: readonly RuleUse[]) {
  return new Set(uses.map((use) => `${use.kind}:${use.key}`)).size;
}

function RuleUseLink({ use, projectId }: { use: RuleUse; projectId: string }) {
  const contents = (
    <>
      <TypeTag>{label(use.kind)}</TypeTag>
      <EntityKey>{use.key}</EntityKey>
      <span className="flex-1 text-[13px] font-medium">{use.title}</span>
      <span className="text-xs text-muted-foreground">
        {useLabel(use)}
        {use.localId ? ` · ${use.localId}` : null}
      </span>
    </>
  );
  const className =
    "flex flex-wrap items-center gap-3 border-t py-2.5 first:border-t-0 hover:bg-secondary/50";
  const search = (previous: { workspace?: string }) => ({
    project: projectId,
    workspace: previous.workspace,
  });

  if (use.kind === "epic") {
    return (
      <Link to="/epic/$epicKey" params={{ epicKey: use.key }} search={search} className={className}>
        {contents}
      </Link>
    );
  }
  if (use.kind === "stream") {
    return (
      <Link
        to="/stream/$streamKey"
        params={{ streamKey: use.key }}
        search={search}
        className={className}
      >
        {contents}
      </Link>
    );
  }
  return (
    <Link to="/task/$taskKey" params={{ taskKey: use.key }} search={search} className={className}>
      {contents}
    </Link>
  );
}

function useLabel(use: RuleUse) {
  switch (use.relation) {
    case "application":
      return "Applies here";
    case "criterion":
      return "Verified by criterion";
    case "constraint":
      return "Task constraint";
    case "revision_pin":
      return use.pinnedRevision === null
        ? "Revision pin"
        : `Pinned at revision ${use.pinnedRevision}`;
  }
}
