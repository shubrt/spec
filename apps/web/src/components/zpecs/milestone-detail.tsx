import { Link } from "@tanstack/react-router";
import { Progress } from "~/components/ui/progress";
import { Panel, PanelTitle, ProseSection, Section } from "~/components/zpecs/document-sections";
import {
  EntityDetailHeader,
  EntityDetailSurfaceProvider,
  type EntityDetailSurface,
} from "~/components/zpecs/entity-detail-header";
import { EntityKey, StatusBadge, StatusDot, TypeTag } from "~/components/zpecs/tokens";
import {
  asArray,
  asRecord,
  asText,
  contentOf,
  type Assumption,
  type MilestoneExitCriterion,
  type OpenQuestion,
} from "~/lib/document";
import { label, milestoneStatus, streamStatus, type Tone } from "~/lib/vocabulary";
import type { MilestoneNode } from "~/server/board";

export function MilestoneDetail({
  milestone,
  surface,
  projectId,
}: {
  milestone: MilestoneNode;
  surface: EntityDetailSurface;
  projectId: string;
}) {
  const content = contentOf(milestone.document);
  const criteria = asArray<MilestoneExitCriterion>(content.exit_criteria);
  const fulfilled = criteria.filter(
    (criterion) => criterion.status === "met" || criterion.status === "waived",
  ).length;
  const pct = criteria.length === 0 ? 0 : Math.round((fulfilled / criteria.length) * 100);
  const questions = asArray<OpenQuestion>(content.open_questions);
  const assumptions = asArray<Assumption>(content.assumptions);

  return (
    <EntityDetailSurfaceProvider surface={surface}>
      <EntityDetailHeader
        surface={surface}
        eyebrow={
          <>
            <span>Milestone</span>
            <EntityKey>{milestone.key}</EntityKey>
          </>
        }
        title={milestone.title}
        metadata={
          <>
            <StatusBadge tone={milestoneStatus.toneOf(milestone.status)}>
              {label(milestone.status)}
            </StatusBadge>
            <span className="text-xs text-muted-foreground">
              roadmap order {milestone.roadmapOrder} · revision {milestone.revision}
            </span>
          </>
        }
      />

      <div className="px-6 pb-10 pt-5">
        {milestone.summary ? (
          <p className="mb-6 text-sm leading-relaxed text-secondary-foreground">
            {milestone.summary}
          </p>
        ) : null}

        <ProseSection title="Goal" value={content.goal} />

        {criteria.length > 0 ? (
          <Section title={`Exit criteria · ${String(fulfilled)}/${String(criteria.length)}`}>
            <div className="mb-3 flex items-center gap-3">
              <Progress value={pct} className="flex-1" />
              <span className="text-xs tabular-nums text-muted-foreground">{pct}%</span>
            </div>
            {criteria.map((criterion, index) => (
              <Panel key={criterion.id ?? index}>
                <div className="flex flex-wrap items-start gap-2">
                  <PanelTitle id={asText(criterion.id)}>{asText(criterion.criterion)}</PanelTitle>
                  <div className="flex-1" />
                  {criterion.status ? (
                    <StatusBadge tone={exitTone(criterion.status)}>
                      {label(criterion.status)}
                    </StatusBadge>
                  ) : null}
                </div>
                {criterion.waiver_reason ? (
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    Waiver: {asText(criterion.waiver_reason)}
                  </p>
                ) : null}
                {criterion.evidence ? (
                  <p className="mt-1 text-xs text-muted-foreground">
                    Evidence: {label(asText(criterion.evidence.basis))}
                    {asArray(criterion.evidence.source_ids).length > 0
                      ? ` · ${asArray(criterion.evidence.source_ids).map(asText).filter(Boolean).join(", ")}`
                      : null}
                  </p>
                ) : null}
              </Panel>
            ))}
          </Section>
        ) : null}

        <Section title={`Roadmap assignments · ${String(milestone.streams.length)}`}>
          <p className="mb-2 text-xs leading-relaxed text-muted-foreground">
            These are roadmap assignments only. Each Stream remains owned by its Epic.
          </p>
          {milestone.streams.length === 0 ? (
            <p className="py-2 text-sm text-muted-foreground">No Streams are assigned.</p>
          ) : (
            milestone.streams.map((stream) => (
              <Link
                key={stream.id}
                to="/stream/$streamKey"
                params={{ streamKey: stream.key }}
                search={(previous) => ({ project: projectId, workspace: previous.workspace })}
                className="flex flex-wrap items-center gap-3 border-t py-2.5 first:border-t-0 hover:bg-secondary/50"
              >
                <StatusDot tone={streamStatus.toneOf(stream.status)} />
                <EntityKey>{stream.key}</EntityKey>
                <span className="flex-1 text-[13px] font-medium">{stream.title}</span>
                <TypeTag>{label(stream.streamType)}</TypeTag>
                <span className="text-xs text-muted-foreground">Epic {stream.epicKey}</span>
                {stream.roadmapRank === null ? null : (
                  <span className="text-xs tabular-nums text-muted-foreground">
                    rank {stream.roadmapRank}
                  </span>
                )}
              </Link>
            ))
          )}
        </Section>

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
              </Panel>
            ))}
          </Section>
        ) : null}

        <MilestoneSources document={milestone.document} />
      </div>
    </EntityDetailSurfaceProvider>
  );
}

function exitTone(status: string): Tone {
  return status === "met" ? "done" : "none";
}

function MilestoneSources({ document }: { document: MilestoneNode["document"] }) {
  const sources = asArray(asRecord(document.provenance).sources);
  if (sources.length === 0) return null;
  return (
    <Section title="Sources">
      {sources.map((rawSource, index) => {
        const source = asRecord(rawSource);
        return (
          <Panel key={asText(source.id) || index}>
            <PanelTitle id={asText(source.id)}>{asText(source.reference)}</PanelTitle>
            {asText(source.type) ? <TypeTag>{label(asText(source.type))}</TypeTag> : null}
          </Panel>
        );
      })}
    </Section>
  );
}
