import { Link } from "@tanstack/react-router";
import {
  Criterion,
  Field,
  ListSection,
  Panel,
  PanelTitle,
  ProseSection,
  RuledBlock,
  Section,
  UnknownsSections,
} from "~/components/zpecs/document-sections";
import {
  EntityDetailHeader,
  EntityDetailSurfaceProvider,
  type EntityDetailSurface,
} from "~/components/zpecs/entity-detail-header";
import { EntityKey, SectionId, StatusBadge, TypeTag } from "~/components/zpecs/tokens";
import {
  asArray,
  asRecord,
  asText,
  contentOf,
  jsonToText,
  type TaskVerification,
  type TechnicalDecision,
} from "~/lib/document";
import { label, taskStatus } from "~/lib/vocabulary";
import type { StreamNode, TaskNode } from "~/server/board";

/**
 * Task detail — the task document.
 *
 * A task is the technical "how". It carries no business targets of its own; it
 * *references* the parent stream's typed anchors through `implements`, which is
 * why the traceability ids get their own section rather than being buried.
 *
 * `execution` is a sibling of `content` in the envelope, not part of it, because
 * it is operational rather than specifying — re-estimating a task does not change
 * what the task says to build. It is rendered last for the same reason.
 */

export function TaskDetail({
  task,
  stream,
  surface,
  projectId,
}: {
  task: TaskNode;
  stream: StreamNode | undefined;
  surface: EntityDetailSurface;
  projectId: string;
}) {
  const content = contentOf(task.document);

  const implementsRef = asRecord(content.implements);
  const implementationTargetIds = IMPLEMENTS_TARGET_FIELDS.flatMap((field) =>
    asArray(implementsRef[field]).map(asText).filter(Boolean),
  );

  const technicalScope = Object.entries(asRecord(content.technical_scope));
  const implementation = asRecord(content.implementation);
  const decisions = asArray<TechnicalDecision>(implementation.technical_decisions);
  const verifications = asArray<TaskVerification>(content.verification);

  // A sibling of `content`, so read from the envelope rather than through it.
  const execution = Object.entries(asRecord(task.document.execution));
  const provenance = asRecord(task.document.provenance);
  const sources = asArray(provenance.sources);

  return (
    <EntityDetailSurfaceProvider surface={surface}>
      <EntityDetailHeader
        surface={surface}
        eyebrow={
          <>
            <span>Task</span>
            <EntityKey>{task.key}</EntityKey>
            <TypeTag>{label(task.taskType)}</TypeTag>
          </>
        }
        title={task.title}
        metadata={
          <>
            <StatusBadge tone={taskStatus.toneOf(task.status)}>{label(task.status)}</StatusBadge>
            <span className="text-xs text-muted-foreground">revision {task.revision}</span>
            {stream ? (
              <>
                <span className="text-xs text-muted-foreground">in</span>
                {surface === "drawer" ? (
                  <Link
                    to="."
                    search={(prev) => ({
                      project: projectId,
                      workspace: prev.workspace,
                      stream: stream.id,
                    })}
                    className="rounded-full bg-secondary px-2.5 py-0.5 text-xs font-medium text-secondary-foreground hover:underline"
                  >
                    {stream.key} {stream.title}
                  </Link>
                ) : (
                  <Link
                    to="/stream/$streamKey"
                    params={{ streamKey: stream.key }}
                    search={(prev) => ({ project: projectId, workspace: prev.workspace })}
                    className="rounded-full bg-secondary px-2.5 py-0.5 text-xs font-medium text-secondary-foreground hover:underline"
                  >
                    {stream.key} {stream.title}
                  </Link>
                )}
              </>
            ) : null}
          </>
        }
      />

      <div className="px-6 pb-10 pt-5">
        {task.summary ? (
          <p className="mb-6 text-sm leading-relaxed text-secondary-foreground">{task.summary}</p>
        ) : null}

        <ProseSection title="Objective" value={content.objective} />

        {implementationTargetIds.length > 0 ? (
          <Section title="Implements">
            {/* Links back to the parent Stream's typed business anchors. Their
                namespace prefixes keep the compact list unambiguous. */}
            <div className="flex flex-wrap gap-1.5">
              {implementationTargetIds.map((id) => (
                <SectionId key={id}>{id}</SectionId>
              ))}
            </div>
          </Section>
        ) : null}

        <ProseSection title="Approach" value={implementation.approach} />
        <ListSection title="Steps" items={asArray(implementation.steps)} ordered />

        {decisions.length > 0 ? (
          <Section title="Technical decisions">
            {decisions.map((decision, index) => (
              <RuledBlock key={index}>
                <div className="text-[13px] leading-relaxed">{asText(decision.decision)}</div>
                {/* The reason is the half that makes a decision reviewable. */}
                {decision.reason ? (
                  <div className="mt-1 text-xs text-muted-foreground">
                    Because {asText(decision.reason)}
                  </div>
                ) : null}
                {asArray(decision.alternatives_considered).length > 0 ? (
                  <div className="mt-1 text-xs text-muted-foreground">
                    Considered: {asArray(decision.alternatives_considered).map(asText).join("; ")}
                  </div>
                ) : null}
              </RuledBlock>
            ))}
          </Section>
        ) : null}

        {technicalScope.length > 0 ? (
          <Section title="Technical scope">
            {/* Rendered from whatever keys are present rather than a fixed list:
                these are five plain name lists, and iterating them cannot omit
                one the way a hand-written set of fields could. */}
            <div className="rounded-xl border p-4">
              {technicalScope.map(([name, value]) => (
                <Field key={name} name={name}>
                  {jsonToText(value)}
                </Field>
              ))}
            </div>
          </Section>
        ) : null}

        <ListSection title="Dependencies" items={asArray(content.dependencies)} />

        {verifications.length > 0 ? (
          <Section title="Verification">
            {verifications.map((verification, index) => (
              <Panel key={verification.id ?? index}>
                <PanelTitle id={verification.id}>
                  {verification.type ? label(asText(verification.type)) : "Check"}
                </PanelTitle>
                <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                  <span className="text-muted-foreground">Procedure</span>
                  <span className="text-secondary-foreground">
                    {asText(verification.procedure)}
                  </span>
                  <span className="text-muted-foreground">Expected</span>
                  <span className="text-secondary-foreground">{asText(verification.expected)}</span>
                </div>
              </Panel>
            ))}
          </Section>
        ) : null}

        {asArray(content.done_when).length > 0 ? (
          <Section title="Done when">
            {asArray(content.done_when)
              .map(asText)
              .filter(Boolean)
              .map((line, index) => (
                <Criterion key={index}>{line}</Criterion>
              ))}
          </Section>
        ) : null}

        <ListSection title="Artifacts" items={asArray(content.artifacts)} />
        <UnknownsSections questions={content.open_questions} assumptions={content.assumptions} />

        {sources.length > 0 ? (
          <Section title="Provenance">
            <div className="mb-3">
              <div className="mb-1 text-xs font-semibold text-secondary-foreground">Sources</div>
              {sources.map((value, index) => {
                const source = asRecord(value);
                const type = asText(source.type);
                const reference = asText(source.reference);
                const snapshot = asText(source.snapshot);
                const observedAt = asText(source.observed_at);
                const superseded = asArray(source.supersedes_source_ids)
                  .map(asText)
                  .filter(Boolean);
                return (
                  <RuledBlock key={`${type}-${reference}-${index}`} label={type || undefined}>
                    {reference ? (
                      <div className="text-[13px] leading-relaxed">{reference}</div>
                    ) : null}
                    {snapshot || observedAt ? (
                      <div className="mt-1 text-xs text-muted-foreground">
                        {[snapshot ? `Snapshot: ${snapshot}` : "", observedAt]
                          .filter(Boolean)
                          .join(" · ")}
                      </div>
                    ) : null}
                    {superseded.length > 0 ? (
                      <div className="mt-1 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                        <span>Supersedes</span>
                        {superseded.map((id) => (
                          <SectionId key={id}>{id}</SectionId>
                        ))}
                      </div>
                    ) : null}
                  </RuledBlock>
                );
              })}
            </div>
          </Section>
        ) : null}

        {execution.length > 0 ? (
          <Section title="Execution">
            <div className="rounded-xl border p-4">
              {execution.map(([name, value]) => (
                <Field key={name} name={name}>
                  {jsonToText(value)}
                </Field>
              ))}
            </div>
          </Section>
        ) : null}
      </div>
    </EntityDetailSurfaceProvider>
  );
}

const IMPLEMENTS_TARGET_FIELDS = [
  "requirement_ids",
  "acceptance_criteria_ids",
  "behavior_case_ids",
  "change_ids",
  "hypothesis_ids",
  "research_question_ids",
  "success_criteria_ids",
  "decision_rule_ids",
  "investigation_question_ids",
  "refactor_target_ids",
  "invariant_ids",
  "quality_goal_ids",
  "maintenance_goal_ids",
] as const;
