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
} from "~/components/zpecs/document-sections";
import {
  EntityDetailHeader,
  EntityDetailSurfaceProvider,
  type EntityDetailSurface,
} from "~/components/zpecs/entity-detail-header";
import { EntityKey, StatusBadge, StatusDot, TypeTag } from "~/components/zpecs/tokens";
import {
  asArray,
  asNumber,
  asRecord,
  asText,
  contentOf,
  type AcceptanceCriterion,
  type BusinessRule,
  type EdgeCase,
  type FunctionalRequirement,
  type InvestigationQuestion,
  type NonFunctionalRequirement,
  type ScopeItem,
  type StreamActor,
  type SuccessCriterion,
  type VerticalSlice,
  type Workflow,
  type WorkflowStep,
} from "~/lib/document";
import { label, streamStatus, taskStatus } from "~/lib/vocabulary";
import type { StreamNode } from "~/server/board";

/**
 * Stream detail.
 *
 * The first seven sections are in the plan's order — Purpose, Scope,
 * Requirements, Workflows, Business rules, Edge cases, Acceptance criteria —
 * which mirrors how the domain document itself is structured. That order is
 * deliberate and is not a layout preference.
 *
 * After them come the sections a particular stream type adds. Only `feature`,
 * `bug` and `investigation` have typed schemas; the other four carry the
 * invariant base only. So nothing here assumes a section exists: every block
 * renders from what is actually in the document and disappears when absent,
 * because an empty heading claims a section is blank when the schema never had
 * one.
 */

export function StreamDetail({
  stream,
  surface,
  projectId,
}: {
  stream: StreamNode;
  surface: EntityDetailSurface;
  projectId: string;
}) {
  const content = contentOf(stream.document);

  const scope = asRecord(content.scope);
  const included = asArray<ScopeItem>(scope.included);
  const excluded = asArray<ScopeItem>(scope.excluded);

  const requirements = asRecord(content.requirements);
  const functional = asArray<FunctionalRequirement>(requirements.functional);
  const nonFunctional = asArray<NonFunctionalRequirement>(requirements.non_functional);

  const workflows = asArray<Workflow>(content.workflows);
  const rules = asArray<BusinessRule>(content.business_rules);
  const edgeCases = asArray<EdgeCase>(content.edge_cases);
  const criteria = asArray<AcceptanceCriterion>(content.acceptance_criteria);

  const actor = asRecord(content.actor) as StreamActor;
  const slice = asRecord(content.vertical_slice) as VerticalSlice;

  const questions = asArray<InvestigationQuestion>(content.questions);
  const discoveryScope = asRecord(content.discovery_scope);
  const discoveryIncluded = asArray<ScopeItem>(discoveryScope.included);
  const discoveryExcluded = asArray<ScopeItem>(discoveryScope.excluded);
  const successCriteria = asArray<SuccessCriterion>(content.success_criteria);

  return (
    <EntityDetailSurfaceProvider surface={surface}>
      <EntityDetailHeader
        surface={surface}
        eyebrow={
          <>
            <span>Stream</span>
            <EntityKey>{stream.key}</EntityKey>
            <TypeTag>{label(stream.streamType)}</TypeTag>
          </>
        }
        title={stream.title}
        metadata={
          <>
            <StatusBadge tone={streamStatus.toneOf(stream.status)}>
              {label(stream.status)}
            </StatusBadge>
            <span className="text-xs text-muted-foreground">revision {stream.revision}</span>
          </>
        }
      />

      <div className="px-6 pb-10 pt-5">
        {stream.summary ? (
          <p className="mb-6 text-sm leading-relaxed text-secondary-foreground">{stream.summary}</p>
        ) : null}

        {/* 1 */}
        <ProseSection title="Purpose" value={content.purpose} />

        {/* 2 */}
        {included.length + excluded.length > 0 ? (
          <Section title="Scope">
            {included.length > 0 ? (
              <>
                <div className="mb-1 text-xs font-semibold text-secondary-foreground">Included</div>
                <ScopeLines items={included} />
              </>
            ) : null}
            {excluded.length > 0 ? (
              <>
                <div className="mb-1 mt-3 text-xs font-semibold text-muted-foreground">
                  Excluded
                </div>
                <ScopeLines items={excluded} muted />
              </>
            ) : null}
          </Section>
        ) : null}

        {/* 3 — feature streams only */}
        {functional.length + nonFunctional.length > 0 ? (
          <Section title="Requirements">
            {functional.map((requirement, index) => (
              <Criterion key={requirement.id ?? index} id={requirement.id}>
                {asText(requirement.statement)}
                {requirement.priority ? (
                  <span className="ml-1.5 text-[11px] font-semibold uppercase text-muted-foreground">
                    {label(asText(requirement.priority))}
                  </span>
                ) : null}
              </Criterion>
            ))}
            {nonFunctional.map((requirement, index) => (
              <Criterion key={requirement.id ?? `nfr-${index}`} id={requirement.id}>
                {/* Stated as a measurement rather than an adjective, which is the
                    whole point of the section — so it is rendered as one. */}
                {requirement.category ? `${label(asText(requirement.category))}: ` : null}
                {asText(requirement.metric)} {asText(requirement.operator)}{" "}
                {asNumber(requirement.target) ?? "—"} {asText(requirement.unit)}
              </Criterion>
            ))}
          </Section>
        ) : null}

        {/* 4 */}
        {workflows.length > 0 ? (
          <Section title="Workflows">
            {workflows.map((workflow, index) => (
              <Panel key={workflow.id ?? index}>
                <PanelTitle id={workflow.id}>{asText(workflow.workflow_name)}</PanelTitle>
                {workflow.actor ? (
                  <div className="mb-2 text-xs text-muted-foreground">
                    Actor: {asText(workflow.actor)}
                  </div>
                ) : null}
                {asArray(workflow.preconditions).length > 0 ? (
                  <div className="mb-2 text-xs text-muted-foreground">
                    Preconditions: {asArray(workflow.preconditions).map(asText).join("; ")}
                  </div>
                ) : null}
                <Steps steps={asArray<WorkflowStep>(workflow.steps)} />
              </Panel>
            ))}
          </Section>
        ) : null}

        {/* 5 */}
        {rules.length > 0 ? (
          <Section title="Business rules">
            {rules.map((rule, index) => (
              <RuledBlock key={rule.id ?? index} label={rule.id}>
                <div className="text-[13px] leading-relaxed">{asText(rule.rule)}</div>
                {rule.impact ? (
                  <div className="mt-1 text-xs text-muted-foreground">
                    Impact: {asText(rule.impact)}
                  </div>
                ) : null}
                {rule.consequence ? (
                  <div className="mt-1 text-xs text-muted-foreground">
                    → {asText(rule.consequence)}
                  </div>
                ) : null}
              </RuledBlock>
            ))}
          </Section>
        ) : null}

        {/* 6 */}
        {edgeCases.length > 0 ? (
          <Section title="Edge cases">
            {edgeCases.map((edgeCase, index) => (
              <Panel key={edgeCase.id ?? index}>
                <PanelTitle id={edgeCase.id}>
                  {asText(edgeCase.trigger) || asText(edgeCase.scenario)}
                </PanelTitle>
                <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                  {edgeCase.scenario && edgeCase.trigger ? (
                    <>
                      <span className="text-muted-foreground">Scenario</span>
                      <span className="text-secondary-foreground">{asText(edgeCase.scenario)}</span>
                    </>
                  ) : null}
                  {edgeCase.expected_behavior ? (
                    <>
                      <span className="text-muted-foreground">Expected</span>
                      <span style={{ color: "oklch(0.42 0.12 155)" }}>
                        {asText(edgeCase.expected_behavior)}
                      </span>
                    </>
                  ) : null}
                  {edgeCase.severity ? (
                    <>
                      <span className="text-muted-foreground">Severity</span>
                      <span className="text-secondary-foreground">
                        {label(asText(edgeCase.severity))}
                      </span>
                    </>
                  ) : null}
                </div>
              </Panel>
            ))}
          </Section>
        ) : null}

        {/* 7 — feature streams only */}
        {criteria.length > 0 ? (
          <Section title="Acceptance criteria">
            {criteria.map((criterion, index) => (
              <Criterion key={criterion.id ?? index} id={criterion.id}>
                <span className="text-muted-foreground">Given</span> {asText(criterion.given)}{" "}
                <span className="text-muted-foreground">when</span> {asText(criterion.when)}{" "}
                <span className="text-muted-foreground">then</span> {asText(criterion.then)}
                {criterion.verifies && criterion.verifies.length > 0 ? (
                  <div className="mt-1 text-xs text-muted-foreground">
                    Verifies {criterion.verifies.join(", ")}
                  </div>
                ) : null}
                {criterion.type || criterion.verification ? (
                  <div className="mt-1 text-xs text-muted-foreground">
                    {criterion.type ? label(asText(criterion.type)) : null}
                    {criterion.type && criterion.verification ? " · " : null}
                    {criterion.verification
                      ? `Verified by ${label(asText(criterion.verification))}`
                      : null}
                  </div>
                ) : null}
              </Criterion>
            ))}
          </Section>
        ) : null}

        {/* `bug` streams: the domain spec's three sections, deliberately not a
            user story. */}
        <ListSection title="Reproduction" items={asArray(content.reproduction)} ordered />
        <ProseSection title="Actual behaviour" value={content.actual_behavior} />
        <ProseSection title="Expected behaviour" value={content.expected_behavior} />
        {asText(content.severity) ? (
          <Section title="Severity">
            <TypeTag>{label(asText(content.severity))}</TypeTag>
          </Section>
        ) : null}

        {/* `investigation` streams: "we do not know yet" as a first-class state. */}
        {questions.length > 0 ? (
          <Section title="Questions">
            {questions.map((question, index) => (
              <Panel key={question.id ?? index}>
                <PanelTitle id={question.id}>{asText(question.question)}</PanelTitle>
                {question.why_it_matters ? (
                  <div className="text-xs text-muted-foreground">
                    {asText(question.why_it_matters)}
                  </div>
                ) : null}
              </Panel>
            ))}
          </Section>
        ) : null}

        {discoveryIncluded.length + discoveryExcluded.length > 0 ? (
          <Section title="Discovery scope">
            {discoveryIncluded.length > 0 ? (
              <>
                <div className="mb-1 text-xs font-semibold text-secondary-foreground">Included</div>
                <ScopeLines items={discoveryIncluded} />
              </>
            ) : null}
            {discoveryExcluded.length > 0 ? (
              <>
                <div className="mb-1 mt-3 text-xs font-semibold text-muted-foreground">
                  Excluded
                </div>
                <ScopeLines items={discoveryExcluded} muted />
              </>
            ) : null}
          </Section>
        ) : null}

        {successCriteria.length > 0 ? (
          <Section title="Success criteria">
            {successCriteria.map((criterion, index) => (
              <Criterion key={criterion.id ?? index} id={criterion.id}>
                {asText(criterion.criterion)}
                {criterion.measurement ? (
                  <div className="mt-1 text-xs text-muted-foreground">
                    Measured by {asText(criterion.measurement)}
                  </div>
                ) : null}
              </Criterion>
            ))}
          </Section>
        ) : null}

        <ProseSection title="Expected decision" value={content.expected_decision} />

        {/* Remaining invariant base sections. Present on any stream type, so
            omitting them would hide real work on the four untyped types. */}
        {actor.primary ? (
          <Section title="Actor">
            <div className="rounded-xl border p-4">
              <Field name="primary">{asText(actor.primary)}</Field>
              {asArray(actor.secondary).length > 0 ? (
                <Field name="secondary">{asArray(actor.secondary).map(asText).join(", ")}</Field>
              ) : null}
            </div>
          </Section>
        ) : null}

        {slice.delivers_alone ? (
          <Section title="Vertical slice">
            <div className="rounded-xl border p-4">
              <p className="text-sm leading-relaxed text-secondary-foreground">
                {asText(slice.delivers_alone)}
              </p>
              {typeof slice.needs_no_other_stream === "boolean" ? (
                <div className="mt-3">
                  <Field name="needs no other stream">
                    {slice.needs_no_other_stream ? "Yes" : "No"}
                  </Field>
                </div>
              ) : null}
              {asArray(slice.prerequisites).length > 0 ? (
                <div className="mt-2 text-xs text-muted-foreground">
                  Prerequisites: {asArray(slice.prerequisites).map(asText).join("; ")}
                </div>
              ) : null}
            </div>
          </Section>
        ) : null}

        <ListSection title="Open questions" items={asArray(content.open_questions)} />
        <ListSection title="Assumptions" items={asArray(content.assumptions)} muted />

        {/* The only way to reach a task, and therefore the only way `?task=` gets
            set by the UI rather than typed by hand. */}
        {stream.tasks.length > 0 ? (
          <Section title={`Tasks · ${stream.tasks.length}`}>
            {stream.tasks.map((task) => {
              const contents = (
                <>
                  <StatusDot tone={taskStatus.toneOf(task.status)} />
                  <EntityKey>{task.key}</EntityKey>
                  <span className="flex-1 text-[13px] font-medium">{task.title}</span>
                  <TypeTag>{label(task.taskType)}</TypeTag>
                </>
              );
              const className =
                "flex items-center gap-3 border-t py-2.5 text-left first:border-t-0 hover:bg-secondary/50";

              return surface === "drawer" ? (
                <Link
                  key={task.id}
                  to="."
                  search={(prev) => ({
                    project: projectId,
                    workspace: prev.workspace,
                    task: task.id,
                  })}
                  className={className}
                >
                  {contents}
                </Link>
              ) : (
                <Link
                  key={task.id}
                  to="/task/$taskKey"
                  params={{ taskKey: task.key }}
                  search={(prev) => ({ project: projectId, workspace: prev.workspace })}
                  className={className}
                >
                  {contents}
                </Link>
              );
            })}
          </Section>
        ) : null}
      </div>
    </EntityDetailSurfaceProvider>
  );
}

function ScopeLines({ items, muted }: { items: ScopeItem[]; muted?: boolean }) {
  return (
    <ul>
      {items.map((item, index) => (
        <li
          key={item.id ?? index}
          className={`flex gap-2 py-1.5 text-sm ${muted ? "text-muted-foreground" : "text-secondary-foreground"}`}
        >
          {item.id ? <span className="rule-tag flex-none">{item.id}</span> : null}
          <span>{asText(item.statement)}</span>
        </li>
      ))}
    </ul>
  );
}

function Steps({ steps }: { steps: WorkflowStep[] }) {
  if (steps.length === 0) return null;
  return (
    <ol className="list-none [counter-reset:n]">
      {steps.map((step, index) => (
        <li
          key={step.id ?? index}
          className="relative border-t py-2 pl-[30px] text-sm text-secondary-foreground first:border-t-0 [counter-increment:n] before:absolute before:left-0 before:top-2 before:flex before:size-[19px] before:items-center before:justify-center before:rounded-md before:bg-secondary before:text-[11px] before:font-semibold before:text-muted-foreground before:[content:counter(n)]"
        >
          {asText(step.action)}
          {step.result ? (
            <span className="block text-xs text-muted-foreground">→ {asText(step.result)}</span>
          ) : null}
        </li>
      ))}
    </ol>
  );
}
