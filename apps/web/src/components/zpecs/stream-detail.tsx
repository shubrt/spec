import { Link } from "@tanstack/react-router";
import {
  Criterion,
  Field,
  OrderedList,
  Panel,
  PanelTitle,
  ProseSection,
  RuledBlock,
  RuleApplicationsSection,
  Section,
  UnknownsSections,
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
  type BehaviorCase,
  type ChangeTarget,
  type DecisionRule,
  type EdgeCase,
  type ExperimentHypothesis,
  type FunctionalRequirement,
  type InvestigationQuestion,
  type MaintenanceGoal,
  type MaintenanceRisk,
  type NonFunctionalRequirement,
  type QualityGoal,
  type RefactorInvariant,
  type RefactorTarget,
  type ResearchQuestion,
  type RuleApplication,
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
 * Requirements, Workflows, Rule applications, Edge cases, Acceptance criteria —
 * which mirrors how the domain document itself is structured. That order is
 * deliberate and is not a layout preference.
 *
 * After them come the sections a particular stream type adds. Nothing here
 * assumes a section exists: every block renders from what is actually in the
 * document and disappears when absent, because an empty heading claims a
 * section is blank when the schema never had one.
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
  const ruleApplications = asArray<RuleApplication>(content.rule_applications);
  const edgeCases = asArray<EdgeCase>(content.edge_cases);
  const criteria = asArray<AcceptanceCriterion>(content.acceptance_criteria);

  const actor = asRecord(content.actor) as StreamActor;
  const slice = asRecord(content.vertical_slice) as VerticalSlice;

  const questions = asArray<InvestigationQuestion>(content.questions);
  const discoveryScope = asRecord(content.discovery_scope);
  const discoveryIncluded = asArray<ScopeItem>(discoveryScope.included);
  const discoveryExcluded = asArray<ScopeItem>(discoveryScope.excluded);
  const successCriteria = asArray<SuccessCriterion>(content.success_criteria);

  const behaviorCases = asArray<BehaviorCase>(content.behavior_cases);
  const changes = asArray<ChangeTarget>(content.changes);
  const hypotheses = asArray<ExperimentHypothesis>(content.hypotheses);
  const researchQuestions = asArray<ResearchQuestion>(content.research_questions);
  const decisionRules = asArray<DecisionRule>(content.decision_rules);
  const refactorTargets = asArray<RefactorTarget>(content.refactor_targets);
  const invariants = asArray<RefactorInvariant>(content.invariants);
  const qualityGoals = asArray<QualityGoal>(content.quality_goals);
  const maintenanceGoals = asArray<MaintenanceGoal>(content.maintenance_goals);
  const risks = asArray<MaintenanceRisk>(content.risks);

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
        <RuleApplicationsSection applications={ruleApplications} />

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
            {criteria.map((criterion, index) => {
              const references = acceptanceReferences(criterion);
              return (
                <Criterion key={criterion.id ?? index} id={criterion.id}>
                  <span className="text-muted-foreground">Given</span> {asText(criterion.given)}{" "}
                  <span className="text-muted-foreground">when</span> {asText(criterion.when)}{" "}
                  <span className="text-muted-foreground">then</span> {asText(criterion.then)}
                  {references.length > 0 ? (
                    <div className="mt-1 text-xs text-muted-foreground">
                      Verifies {references.join(", ")}
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
              );
            })}
          </Section>
        ) : null}

        {/* Type-specific business anchors. Each renderer disappears for every
            other Stream type instead of suggesting a missing section. */}
        <BehaviorCasesSection cases={behaviorCases} />
        <ChangeTargetsSection changes={changes} />
        <ExperimentSections
          hypotheses={hypotheses}
          researchQuestions={researchQuestions}
          decisionRules={decisionRules}
        />
        <RefactorSections
          targets={refactorTargets}
          invariants={invariants}
          qualityGoals={qualityGoals}
        />
        <MaintenanceSections goals={maintenanceGoals} risks={risks} />

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

        {/* Remaining invariant base sections. */}
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

        <UnknownsSections questions={content.open_questions} assumptions={content.assumptions} />

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

function BehaviorCasesSection({ cases }: { cases: BehaviorCase[] }) {
  if (cases.length === 0) return null;

  return (
    <Section title="Behaviour cases">
      {cases.map((behaviorCase, index) => {
        const reproduction = asArray(behaviorCase.reproduction).map(asText).filter(Boolean);
        return (
          <Panel key={behaviorCase.id ?? index}>
            <PanelTitle id={behaviorCase.id}>Behaviour case</PanelTitle>
            {reproduction.length > 0 ? (
              <div className="mb-3">
                <div className="mb-1 text-xs font-semibold text-secondary-foreground">
                  Reproduction
                </div>
                <OrderedList items={reproduction} />
              </div>
            ) : null}
            <div className="rounded-xl border px-3">
              {behaviorCase.actual_behavior ? (
                <Field name="actual">{asText(behaviorCase.actual_behavior)}</Field>
              ) : null}
              {behaviorCase.expected_behavior ? (
                <Field name="expected">{asText(behaviorCase.expected_behavior)}</Field>
              ) : null}
              {behaviorCase.severity ? (
                <Field name="severity">
                  <TypeTag>{label(asText(behaviorCase.severity))}</TypeTag>
                </Field>
              ) : null}
            </div>
          </Panel>
        );
      })}
    </Section>
  );
}

function ChangeTargetsSection({ changes }: { changes: ChangeTarget[] }) {
  if (changes.length === 0) return null;

  return (
    <Section title="Changes">
      {changes.map((change, index) => (
        <Panel key={change.id ?? index}>
          <PanelTitle id={change.id}>{asText(change.trigger) || "Change target"}</PanelTitle>
          <div className="rounded-xl border px-3">
            {change.current_state ? (
              <Field name="current">{asText(change.current_state)}</Field>
            ) : null}
            {change.desired_state ? (
              <Field name="desired">{asText(change.desired_state)}</Field>
            ) : null}
            {change.success_measure ? (
              <Field name="success">{asText(change.success_measure)}</Field>
            ) : null}
          </div>
        </Panel>
      ))}
    </Section>
  );
}

function ExperimentSections({
  hypotheses,
  researchQuestions,
  decisionRules,
}: {
  hypotheses: ExperimentHypothesis[];
  researchQuestions: ResearchQuestion[];
  decisionRules: DecisionRule[];
}) {
  return (
    <>
      {hypotheses.length > 0 ? (
        <Section title="Hypotheses">
          {hypotheses.map((hypothesis, index) => (
            <RuledBlock key={hypothesis.id ?? index} label={hypothesis.id}>
              <div className="text-[13px] leading-relaxed">{asText(hypothesis.hypothesis)}</div>
            </RuledBlock>
          ))}
        </Section>
      ) : null}

      {researchQuestions.length > 0 ? (
        <Section title="Research questions">
          {researchQuestions.map((question, index) => (
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

      {decisionRules.length > 0 ? (
        <Section title="Decision rules">
          {decisionRules.map((rule, index) => (
            <Panel key={rule.id ?? index}>
              <PanelTitle id={rule.id}>Decision rule</PanelTitle>
              <div className="rounded-xl border px-3">
                {rule.condition ? <Field name="if">{asText(rule.condition)}</Field> : null}
                {rule.decision ? <Field name="then">{asText(rule.decision)}</Field> : null}
              </div>
            </Panel>
          ))}
        </Section>
      ) : null}
    </>
  );
}

function RefactorSections({
  targets,
  invariants,
  qualityGoals,
}: {
  targets: RefactorTarget[];
  invariants: RefactorInvariant[];
  qualityGoals: QualityGoal[];
}) {
  return (
    <>
      {targets.length > 0 ? (
        <Section title="Refactor targets">
          {targets.map((target, index) => (
            <Panel key={target.id ?? index}>
              <PanelTitle id={target.id}>Refactor target</PanelTitle>
              <div className="rounded-xl border px-3">
                {target.current_state ? (
                  <Field name="current">{asText(target.current_state)}</Field>
                ) : null}
                {target.target_state ? (
                  <Field name="target">{asText(target.target_state)}</Field>
                ) : null}
              </div>
            </Panel>
          ))}
        </Section>
      ) : null}

      {invariants.length > 0 ? (
        <Section title="Invariants">
          {invariants.map((invariant, index) => (
            <RuledBlock key={invariant.id ?? index} label={invariant.id}>
              <div className="text-[13px] leading-relaxed">{asText(invariant.statement)}</div>
            </RuledBlock>
          ))}
        </Section>
      ) : null}

      {qualityGoals.length > 0 ? (
        <Section title="Quality goals">
          {qualityGoals.map((goal, index) => (
            <Panel key={goal.id ?? index}>
              <PanelTitle id={goal.id}>{asText(goal.goal)}</PanelTitle>
              {goal.measurement ? (
                <div className="text-xs text-muted-foreground">
                  Measured by {asText(goal.measurement)}
                </div>
              ) : null}
            </Panel>
          ))}
        </Section>
      ) : null}
    </>
  );
}

function MaintenanceSections({
  goals,
  risks,
}: {
  goals: MaintenanceGoal[];
  risks: MaintenanceRisk[];
}) {
  return (
    <>
      {goals.length > 0 ? (
        <Section title="Maintenance goals">
          {goals.map((goal, index) => (
            <Panel key={goal.id ?? index}>
              <PanelTitle id={goal.id}>{asText(goal.goal)}</PanelTitle>
              {goal.done_when ? (
                <div className="text-xs text-muted-foreground">
                  Done when {asText(goal.done_when)}
                </div>
              ) : null}
            </Panel>
          ))}
        </Section>
      ) : null}

      {risks.length > 0 ? (
        <Section title="Risks">
          {risks.map((risk, index) => (
            <RuledBlock key={risk.id ?? index} label={risk.id}>
              <div className="text-[13px] leading-relaxed">{asText(risk.risk)}</div>
              {risk.mitigation ? (
                <div className="mt-1 text-xs text-muted-foreground">
                  Mitigation: {asText(risk.mitigation)}
                </div>
              ) : null}
              {risk.severity ? (
                <div className="mt-1">
                  <TypeTag>{label(asText(risk.severity))}</TypeTag>
                </div>
              ) : null}
            </RuledBlock>
          ))}
        </Section>
      ) : null}
    </>
  );
}

function acceptanceReferences(criterion: AcceptanceCriterion): string[] {
  const verifies = asRecord(criterion.verifies);
  return [...asArray(verifies.requirement_ids), ...asArray(verifies.rule_keys)]
    .map(asText)
    .filter(Boolean);
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
